import fs from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const highConfidenceSecretPatterns = [
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|oauth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}["']?/gi,
  /\bauthorization:\s*(?:bearer|basic)\s+[^\s]+/gi,
];

const publicStatuses = {
  "human-attention": {
    schemaVersion: 1,
    code: "agent_needs_input",
    message: "The coding agent needs operator input. Review trusted local logs before resuming.",
  },
  "run-failed": {
    schemaVersion: 1,
    code: "agent_run_failed",
    message: "The coding run failed. Review trusted local logs before resuming.",
  },
  "publication-failed": {
    schemaVersion: 1,
    code: "publication_failed",
    message: "Publication failed. Review trusted local logs before retrying.",
  },
  "stale-base": {
    schemaVersion: 1,
    code: "publication_base_changed",
    message: "The base branch changed. The stale artifact was retained for audit; resume to rerun from the fresh base.",
  },
} as const;

export function redactForGithub(value: string, configuredSecrets: Array<string | undefined>) {
  let redacted = value;
  for (const secret of configuredSecrets) {
    if (secret && secret.length >= 6) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|oauth[_-]?token|client[_-]?secret|password)\s*[:=]\s*)["']?[A-Za-z0-9_./+=-]{20,}["']?/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, "$1[REDACTED]");
}

export function publicHarnessStatus(kind: keyof typeof publicStatuses) {
  return JSON.stringify(publicStatuses[kind]);
}

export function assertNoHighConfidenceSecrets(
  value: Buffer | string,
  configuredSecrets: Array<string | undefined>,
) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  for (const secret of configuredSecrets) {
    if (secret && secret.length >= 6 && bytes.includes(Buffer.from(secret))) {
      throw new Error("Publication artifact contains credential material");
    }
  }
  const text = bytes.toString("utf8");
  if (highConfidenceSecretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  })) {
    throw new Error("Publication artifact contains credential material");
  }
}

export async function assertNoRepositoryEnvironmentPassthrough(workspace: string) {
  const envFile = path.join(workspace, ".sandcastle", ".env");
  try {
    await fs.access(envFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Refusing repository-controlled .sandcastle/.env environment pass-through");
}

export function sandboxControlEnvironment() {
  return {
    DOCKER_HOST: "",
    DOCKER_TLS_VERIFY: "",
    DOCKER_CERT_PATH: "",
  };
}

export async function ensurePrivateRuntimeDirectory(directory: string) {
  const expected = path.resolve(directory);
  await fs.mkdir(expected, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(expected)).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link runtime directory: ${expected}`);
  }
  await fs.chmod(expected, 0o700);
}

export async function ensureRuntimeIdentity(dataDir: string, repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid repository identity");
  }
  await ensurePrivateRuntimeDirectory(dataDir);
  const marker = path.join(dataDir, "repository-identity.json");
  const expected = `${JSON.stringify({ schemaVersion: 1, repository })}\n`;
  try {
    await fs.writeFile(marker, expected, { flag: "wx", mode: 0o400 });
    await fsyncDirectory(dataDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o222) {
    throw new Error("Repository identity marker is mutable or has an unsafe type");
  }
  if (await fs.readFile(marker, "utf8") !== expected) {
    throw new Error("Harness data root belongs to a different repository");
  }
}

export async function fsyncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function acquireProcessLock(dataDir: string) {
  await ensurePrivateRuntimeDirectory(dataDir);
  const lockPath = path.join(dataDir, "runtime.lock");
  const identity = {
    schemaVersion: 1,
    pid: process.pid,
    processStart: await linuxProcessStart(process.pid),
    nonce: randomUUID(),
  };
  const content = `${JSON.stringify(identity)}\n`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
      await fsyncDirectory(dataDir);
      const release = async () => {
        if (await lockMatches(lockPath, content)) {
          await fs.unlink(lockPath);
          await fsyncDirectory(dataDir);
        }
      };
      const releaseOnExit = () => {
        try {
          if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
        } catch {
          // Exit cleanup is best-effort; stale-lock recovery validates process identity.
        }
      };
      process.once("exit", releaseOnExit);
      return {
        release: async () => {
          process.removeListener("exit", releaseOnExit);
          await release();
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe harness runtime lock type");
    const existing = parseProcessLock(await fs.readFile(lockPath, "utf8"));
    if (await processIdentityIsAlive(existing.pid, existing.processStart)) {
      throw new Error("Another issue-harness process already owns HARNESS_DATA_DIR");
    }
    try {
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      await fs.rename(lockPath, stalePath);
      await fs.rm(stalePath, { force: true });
      await fsyncDirectory(dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Unable to acquire issue-harness runtime lock");
}

function parseProcessLock(content: string): { pid: number; processStart: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Invalid harness runtime lock");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
    || !Number.isSafeInteger((parsed as { pid?: unknown }).pid)
    || ((parsed as { pid: number }).pid <= 0)
    || !(
      (parsed as { processStart?: unknown }).processStart === null
      || typeof (parsed as { processStart?: unknown }).processStart === "string"
    )
    || typeof (parsed as { nonce?: unknown }).nonce !== "string"
  ) {
    throw new Error("Invalid harness runtime lock");
  }
  return parsed as { pid: number; processStart: string | null };
}

async function processIdentityIsAlive(pid: number, expectedStart: string | null) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (expectedStart === null) return true;
  return await linuxProcessStart(pid) === expectedStart;
}

async function linuxProcessStart(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis === -1) return null;
    return stat.slice(closingParenthesis + 2).split(" ")[19] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function lockMatches(lockPath: string, expected: string) {
  try {
    return await fs.readFile(lockPath, "utf8") === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function withSanitizedProcessEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const removed = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/.test(key)) {
      removed.set(key, value);
      delete process.env[key];
    }
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of removed) process.env[key] = value;
  }
}
