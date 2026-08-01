import dotenv from "dotenv";
import path from "node:path";

const repoRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config();
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function positiveIntegerEnv(name: string) {
  const value = required(name);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function strongSecret(name: string) {
  const value = required(name);
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

function optionalStrongSecret(name: string) {
  const value = process.env[name];
  if (!value) return undefined;
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

function absolutePathEnv(name: string) {
  const value = required(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}

function serverUrl() {
  const url = new URL(required("OPENCODE_SERVER_URL"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("OPENCODE_SERVER_URL must be a plain HTTP(S) origin");
  }
  return url.toString().replace(/\/$/, "");
}

if (process.env.VOID_AI_API_KEY) {
  throw new Error("VOID_AI_API_KEY must not be configured on the issue harness; configure it only on OpenCode Web");
}
if (process.env.GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN is no longer supported; configure GitHub App credentials instead");
}

const dataDir = path.resolve(repoRoot, process.env.HARNESS_DATA_DIR ?? ".harness");
if (process.env.HARNESS_DATA_DIR && (!dataDir.startsWith(`/opt/issue-harness${path.sep}`) || dataDir === "/opt/issue-harness")) {
  throw new Error("HARNESS_DATA_DIR must be a per-repository child of /opt/issue-harness");
}
const openCodeModelId = process.env.OPENCODE_MODEL_ID ?? "gpt-5.6-sol";
if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(openCodeModelId)) {
  throw new Error("OPENCODE_MODEL_ID must be a bounded model identifier");
}
const maxConcurrentRuns = numberEnv("MAX_CONCURRENT_RUNS", 1);
if (maxConcurrentRuns !== 1) throw new Error("MAX_CONCURRENT_RUNS must be 1 until distributed issue leases are implemented");
const workspaceRetentionHours = numberEnv("WORKSPACE_RETENTION_HOURS", 24);

export const config = {
  repoRoot,
  githubAppId: positiveIntegerEnv("GITHUB_APP_ID"),
  githubAppInstallationId: positiveIntegerEnv("GITHUB_APP_INSTALLATION_ID"),
  githubAppPrivateKeyPath: absolutePathEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
  owner: required("GITHUB_OWNER"),
  repo: required("GITHUB_REPO"),
  baseBranch: process.env.GITHUB_BASE_BRANCH ?? "stage",
  harnessCommandToken: strongSecret("HARNESS_COMMAND_TOKEN"),
  pollIntervalMs: numberEnv("POLL_INTERVAL_SECONDS", 60) * 1000,
  healthPort: numberEnv("HEALTH_PORT", 3000),
  healthDetailsToken: optionalStrongSecret("HARNESS_HEALTH_DETAILS_TOKEN"),
  maxConcurrentRuns,
  openCodeServerUrl: serverUrl(),
  openCodeInternalToken: strongSecret("OPENCODE_INTERNAL_TOKEN"),
  openCodeParentDirectory: absolutePathEnv("OPENCODE_PARENT_DIRECTORY"),
  openCodeModelId,
  contextDir: path.join(dataDir, "context"),
  contextRefreshMs: numberEnv("CONTEXT_REFRESH_SECONDS", 60) * 1000,
  workspaceRetentionMs: workspaceRetentionHours * 60 * 60 * 1000,
  dataDir,
};
