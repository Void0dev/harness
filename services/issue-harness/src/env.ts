import "dotenv/config";
import path from "node:path";

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

export const config = {
  githubToken: required("GITHUB_TOKEN"),
  owner: required("GITHUB_OWNER"),
  repo: required("GITHUB_REPO"),
  baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
  pollIntervalMs: numberEnv("POLL_INTERVAL_SECONDS", 60) * 1000,
  maxConcurrentRuns: numberEnv("MAX_CONCURRENT_RUNS", 1),
  codexModel: process.env.CODEX_MODEL ?? "gpt-5.4",
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "high",
  sandcastleImage: process.env.SANDCASTLE_IMAGE ?? "sandcastle-harness:latest",
  dataDir: path.resolve(process.env.HARNESS_DATA_DIR ?? ".harness"),
};
