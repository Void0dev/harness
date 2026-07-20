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

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalStrongSecret(name: string) {
  const value = process.env[name];
  if (!value) return undefined;
  if (value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return value;
}

function strongSecret(name: string) {
  const value = required(name);
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const value = numberEnv(name, fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function decimalEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const value = numberEnv(name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function identifierEnv(name: string) {
  const value = required(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`${name} must be a bounded identifier`);
  }
  return value;
}

function brokerUrl() {
  const parsed = new URL(required("CODEX_BROKER_URL"));
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/v1"
  ) {
    throw new Error("CODEX_BROKER_URL must be an http(s) origin ending in /v1 without credentials or query data");
  }
  return parsed.toString().replace(/\/$/, "");
}

if (process.env.CODEX_AUTH_MODE && process.env.CODEX_AUTH_MODE !== "broker") {
  throw new Error("Untrusted execution requires CODEX_AUTH_MODE=broker; direct API-key and subscription modes are forbidden");
}
if (process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must not be configured on the issue harness; use the broker signing contract");
}

const sandcastleImage = process.env.SANDCASTLE_IMAGE ?? "sandcastle-harness:0.1.0";
if (
  booleanEnv("REQUIRE_PINNED_IMAGES", false)
  && !/^ghcr\.io\/void0dev\/sandcastle-harness@sha256:[0-9a-f]{64}$/.test(sandcastleImage)
) {
  throw new Error("SANDCASTLE_IMAGE must use the canonical image coordinate and lowercase sha256 digest");
}
const dataDir = path.resolve(repoRoot, process.env.HARNESS_DATA_DIR ?? ".harness");
if (
  process.env.HARNESS_DATA_DIR
  && (!dataDir.startsWith(`/opt/issue-harness${path.sep}`) || dataDir === "/opt/issue-harness")
) {
  throw new Error("HARNESS_DATA_DIR must be a per-repository child of /opt/issue-harness");
}

function dockerDaemonContract() {
  const dockerHost = required("DOCKER_HOST");
  if (dockerHost === "unix:///var/run/docker.sock") {
    throw new Error("The conventional rootful Docker socket is forbidden");
  }
  if (dockerHost.startsWith("unix:///")) {
    return {
      mode: "local-rootless" as const,
      expectedId: required("SANDBOX_DOCKER_DAEMON_ID"),
    };
  }
  if (dockerHost.startsWith("tcp://")) {
    if (process.env.DOCKER_TLS_VERIFY !== "1") {
      throw new Error("Remote Docker requires DOCKER_TLS_VERIFY=1");
    }
    if (path.resolve(process.env.DOCKER_CERT_PATH ?? "") !== path.join(dataDir, "docker-certs")) {
      throw new Error("DOCKER_CERT_PATH must be HARNESS_DATA_DIR/docker-certs");
    }
    return { mode: "remote-tls" as const, expectedId: undefined };
  }
  throw new Error("DOCKER_HOST must explicitly select a rootless unix socket or remote TLS daemon");
}

const sandboxDaemon = dockerDaemonContract();

export const config = {
  repoRoot,
  githubToken: required("GITHUB_TOKEN"),
  owner: required("GITHUB_OWNER"),
  repo: required("GITHUB_REPO"),
  baseBranch: process.env.GITHUB_BASE_BRANCH ?? "stage",
  pollIntervalMs: numberEnv("POLL_INTERVAL_SECONDS", 60) * 1000,
  healthPort: numberEnv("HEALTH_PORT", 3000),
  healthDetailsToken: optionalStrongSecret("HARNESS_HEALTH_DETAILS_TOKEN"),
  maxConcurrentRuns: singleWorkerConcurrency(),
  codexBrokerUrl: brokerUrl(),
  codexBrokerAudience: identifierEnv("CODEX_BROKER_AUDIENCE"),
  codexBrokerSigningSecret: strongSecret("CODEX_BROKER_SIGNING_SECRET"),
  codexBrokerTokenTtlSeconds: integerEnv("CODEX_BROKER_TOKEN_TTL_SECONDS", 1800, 60, 3600),
  codexModel: process.env.CODEX_MODEL ?? "gpt-5.4",
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "high",
  sandcastleImage,
  sandboxNetwork: identifierEnv("SANDBOX_NETWORK"),
  sandboxMemoryMb: integerEnv("SANDBOX_MEMORY_MB", 4096, 256, 65_536),
  sandboxCpus: decimalEnv("SANDBOX_CPUS", 2, 0.25, 64),
  sandboxPidsLimit: integerEnv("SANDBOX_PIDS_LIMIT", 256, 32, 4096),
  sandboxTmpfsMb: integerEnv("SANDBOX_TMPFS_MB", 256, 32, 4096),
  sandboxMaxOutputBytes: integerEnv("SANDBOX_MAX_OUTPUT_BYTES", 4 * 1024 * 1024, 65_536, 16 * 1024 * 1024),
  sandboxDaemonMode: sandboxDaemon.mode,
  sandboxDockerDaemonId: sandboxDaemon.expectedId,
  dataDir,
};
