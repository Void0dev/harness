import fs from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function ensurePrivateRuntimeDirectory(directory: string) {
  await ensureRuntimeDirectory(directory, 0o700);
}

export async function ensureSharedRuntimeDirectory(directory: string) {
  await ensureRuntimeDirectory(directory, 0o2770);
}

async function ensureRuntimeDirectory(directory: string, mode: number) {
  const expected = path.resolve(directory);
  await fs.mkdir(expected, { recursive: true, mode });
  if ((await fs.lstat(expected)).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link runtime directory: ${expected}`);
  }
  await fs.chmod(expected, mode);
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
