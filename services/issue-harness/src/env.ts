import dotenv from "dotenv";
import path from "node:path";

const repoRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());

dotenv.config({
  path: path.join(repoRoot, ".env"),
});

dotenv.config();

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function singleWorkerConcurrency() {
  const value = numberEnv("MAX_CONCURRENT_RUNS", 1);
  if (value !== 1) {
    throw new Error("MAX_CONCURRENT_RUNS must be 1 until distributed issue leases are implemented");
  }
  return value;
}

function choiceEnv<const T extends readonly string[]>(name: string, choices: T, fallback: T[number]) {
  const value = process.env[name] ?? fallback;
  if (!choices.includes(value as T[number])) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  }
  return value as T[number];
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const sandcastleImage = process.env.SANDCASTLE_IMAGE ?? "sandcastle-harness:0.1.0";
if (booleanEnv("REQUIRE_PINNED_IMAGES", false) && !/@sha256:[0-9a-f]{64}$/i.test(sandcastleImage)) {
  throw new Error("SANDCASTLE_IMAGE must use an immutable sha256 digest");
}
const dataDir = path.resolve(repoRoot, process.env.HARNESS_DATA_DIR ?? ".harness");
if (
  process.env.HARNESS_DATA_DIR
  && (!dataDir.startsWith(`/opt/issue-harness${path.sep}`) || dataDir === "/opt/issue-harness")
) {
  throw new Error("HARNESS_DATA_DIR must be a per-repository child of /opt/issue-harness");
}

export const config = {
  repoRoot,
  githubToken: required("GITHUB_TOKEN"),
  owner: required("GITHUB_OWNER"),
  repo: required("GITHUB_REPO"),
  baseBranch: process.env.GITHUB_BASE_BRANCH ?? "stage",
  pollIntervalMs: numberEnv("POLL_INTERVAL_SECONDS", 60) * 1000,
  healthPort: numberEnv("HEALTH_PORT", 3000),
  maxConcurrentRuns: singleWorkerConcurrency(),
  codexAuthMode: choiceEnv("CODEX_AUTH_MODE", ["api-key", "subscription"] as const, "api-key"),
  codexModel: process.env.CODEX_MODEL ?? "gpt-5.4",
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "high",
  sandcastleImage,
  dataDir,
};
