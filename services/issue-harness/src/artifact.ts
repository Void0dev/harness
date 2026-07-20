import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertNoHighConfidenceSecrets, ensurePrivateRuntimeDirectory } from "./security.js";

const execFileAsync = promisify(execFile);
const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const maxPatchBytes = 10 * 1024 * 1024;
const maxPaths = 2_000;

export type PublicationArtifactReference = {
  manifestPath: string;
  manifestSha256: string;
};

export type PublicationArtifactManifest = {
  schemaVersion: 1;
  issueNumber: number;
  branch: string;
  baseSha: string;
  createdAt: string;
  patchFile: string;
  patchSha256: string;
  patchBytes: number;
  paths: string[];
};

export type LoadedPublicationArtifact = {
  manifest: PublicationArtifactManifest;
  patch: Buffer;
};

export async function createPublicationArtifact(options: {
  dataDir: string;
  issueNumber: number;
  branch: string;
  workspace: string;
  baseSha: string;
  configuredSecrets?: Array<string | undefined>;
}): Promise<PublicationArtifactReference> {
  assertIssueNumber(options.issueNumber);
  assertBranch(options.branch);
  if (!oidPattern.test(options.baseSha)) {
    throw new Error(`Invalid artifact base SHA: ${options.baseSha}`);
  }

  const pathsOutput = await untrustedGit(
    options.workspace,
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    options.baseSha,
    options.branch,
    "--",
  );
  const paths = pathsOutput.toString("utf8").split("\0").filter(Boolean).sort();
  if (paths.length === 0) throw new Error("Publication artifact has no changed paths");
  if (paths.length > maxPaths) throw new Error(`Publication artifact exceeds ${maxPaths} paths`);
  if (new Set(paths).size !== paths.length) throw new Error("Publication artifact has duplicate paths");
  for (const changedPath of paths) {
    assertSafeArtifactPath(changedPath);
    await assertRegularBlobChange(options.workspace, options.baseSha, options.branch, changedPath);
  }

  const patch = await untrustedGit(
    options.workspace,
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    options.baseSha,
    options.branch,
    "--",
  );
  if (patch.length === 0) throw new Error("Publication artifact patch is empty");
  if (patch.length > maxPatchBytes) {
    throw new Error(`Publication artifact patch exceeds ${maxPatchBytes} bytes`);
  }
  assertNoHighConfidenceSecrets(patch, options.configuredSecrets ?? []);

  const patchSha256 = sha256(patch);
  const patchFile = `${patchSha256}.patch`;
  const manifest: PublicationArtifactManifest = {
    schemaVersion: 1,
    issueNumber: options.issueNumber,
    branch: options.branch,
    baseSha: options.baseSha,
    createdAt: new Date().toISOString(),
    patchFile,
    patchSha256,
    patchBytes: patch.length,
    paths,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha256 = sha256(manifestBytes);
  const artifactDirectory = path.resolve(options.dataDir, "artifacts", `issue-${options.issueNumber}`);
  await ensurePrivateRuntimeDirectory(path.resolve(options.dataDir, "artifacts"));
  await ensurePrivateRuntimeDirectory(artifactDirectory);
  const patchPath = path.join(artifactDirectory, patchFile);
  const manifestPath = path.join(artifactDirectory, `${manifestSha256}.json`);
  await writeContentAddressedFile(patchPath, patch);
  await writeContentAddressedFile(manifestPath, manifestBytes);
  return { manifestPath, manifestSha256 };
}

export async function loadPublicationArtifact(options: {
  dataDir: string;
  issueNumber: number;
  branch: string;
  reference: PublicationArtifactReference;
}): Promise<LoadedPublicationArtifact> {
  assertIssueNumber(options.issueNumber);
  assertBranch(options.branch);
  if (!/^[0-9a-f]{64}$/.test(options.reference.manifestSha256)) {
    throw new Error("Invalid publication manifest hash");
  }
  const artifactDirectory = path.resolve(options.dataDir, "artifacts", `issue-${options.issueNumber}`);
  const manifestPath = path.resolve(options.reference.manifestPath);
  if (
    path.dirname(manifestPath) !== artifactDirectory
    || path.basename(manifestPath) !== `${options.reference.manifestSha256}.json`
  ) {
    throw new Error("Publication manifest escapes its trusted artifact directory");
  }
  await assertRegularArtifactFile(artifactDirectory, 0);
  await assertRegularArtifactFile(manifestPath, 64 * 1024);
  const manifestBytes = await fs.readFile(manifestPath);
  if (sha256(manifestBytes) !== options.reference.manifestSha256) {
    throw new Error("Publication manifest hash mismatch");
  }

  const parsed = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const expectedKeys = [
    "baseSha",
    "branch",
    "createdAt",
    "issueNumber",
    "patchBytes",
    "patchFile",
    "patchSha256",
    "paths",
    "schemaVersion",
  ];
  if (Object.keys(parsed).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error("Publication manifest has an unexpected schema");
  }
  if (
    parsed.schemaVersion !== 1
    || parsed.issueNumber !== options.issueNumber
    || parsed.branch !== options.branch
    || typeof parsed.baseSha !== "string"
    || !oidPattern.test(parsed.baseSha)
    || typeof parsed.createdAt !== "string"
    || new Date(parsed.createdAt).toISOString() !== parsed.createdAt
    || typeof parsed.patchFile !== "string"
    || typeof parsed.patchSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(parsed.patchSha256)
    || parsed.patchFile !== `${parsed.patchSha256}.patch`
    || typeof parsed.patchBytes !== "number"
    || !Number.isSafeInteger(parsed.patchBytes)
    || parsed.patchBytes <= 0
    || parsed.patchBytes > maxPatchBytes
    || !Array.isArray(parsed.paths)
    || parsed.paths.length === 0
    || parsed.paths.length > maxPaths
    || parsed.paths.some((item) => typeof item !== "string")
  ) {
    throw new Error("Publication manifest failed validation");
  }
  const paths = parsed.paths as string[];
  if ([...paths].sort().join("\0") !== paths.join("\0") || new Set(paths).size !== paths.length) {
    throw new Error("Publication manifest paths are not canonical");
  }
  for (const changedPath of paths) assertSafeArtifactPath(changedPath);

  const patchPath = path.join(artifactDirectory, parsed.patchFile);
  await assertRegularArtifactFile(patchPath, maxPatchBytes);
  const patch = await fs.readFile(patchPath);
  if (patch.length !== parsed.patchBytes || sha256(patch) !== parsed.patchSha256) {
    throw new Error("Publication patch hash or length mismatch");
  }
  return { manifest: parsed as unknown as PublicationArtifactManifest, patch };
}

function assertIssueNumber(issueNumber: number) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid artifact issue number: ${issueNumber}`);
  }
}

function assertBranch(branch: string) {
  if (
    !branchPattern.test(branch)
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || branch.endsWith(".")
    || branch.endsWith("/")
  ) {
    throw new Error(`Invalid artifact branch: ${branch}`);
  }
}

function assertSafeArtifactPath(changedPath: string) {
  const segments = changedPath.split("/");
  if (
    path.posix.isAbsolute(changedPath)
    || changedPath.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(changedPath)
    || segments.some((segment) =>
      segment === ""
      || segment === "."
      || segment === ".."
      || segment.toLowerCase() === ".git"
      || segment.endsWith(" ")
      || segment.endsWith(".")
    )
    || changedPath === ".gitmodules"
  ) {
    throw new Error(`Unsafe artifact path: ${JSON.stringify(changedPath)}`);
  }
}

async function assertRegularArtifactFile(filePath: string, maxBytes: number) {
  const stat = await fs.lstat(filePath);
  if ((maxBytes === 0 && !stat.isDirectory()) || (maxBytes !== 0 && !stat.isFile())) {
    throw new Error(`Unsafe publication artifact type: ${filePath}`);
  }
  if (maxBytes !== 0 && stat.size > maxBytes) {
    throw new Error(`Publication artifact exceeds ${maxBytes} bytes: ${filePath}`);
  }
}

async function assertRegularBlobChange(
  workspace: string,
  baseSha: string,
  branch: string,
  changedPath: string,
) {
  const entries = [
    ...await treeEntries(workspace, baseSha, changedPath),
    ...await treeEntries(workspace, branch, changedPath),
  ];
  for (const entry of entries) {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error(`Unsupported artifact entry ${changedPath}: ${entry.mode} ${entry.type}`);
    }
  }
}

async function treeEntries(workspace: string, treeish: string, changedPath: string) {
  const output = await untrustedGit(workspace, "ls-tree", "-z", treeish, "--", changedPath);
  if (output.length === 0) return [];
  return output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) ([^ ]+) [0-9a-f]+\t/.exec(record);
    if (!match) throw new Error(`Unable to inspect artifact entry: ${changedPath}`);
    return { mode: match[1], type: match[2] };
  });
}

async function untrustedGit(cwd: string, ...args: string[]) {
  const result = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    },
    encoding: "buffer",
    maxBuffer: maxPatchBytes + 1024 * 1024,
  });
  return result.stdout as Buffer;
}

async function writeContentAddressedFile(filePath: string, bytes: Buffer) {
  try {
    const existing = await fs.readFile(filePath);
    if (!existing.equals(bytes)) throw new Error(`Content-addressed artifact collision: ${filePath}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o400 });
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
