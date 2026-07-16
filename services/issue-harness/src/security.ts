import fs from "node:fs/promises";
import path from "node:path";

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
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, "$1[REDACTED]");
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
