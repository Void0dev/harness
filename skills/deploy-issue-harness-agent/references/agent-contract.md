# Issue agent contract

## Runtime states and labels

The current listener contract is exact:

```text
ai:backlog -> ai:todo -> ai:running -> ai:finished
                                  \-> ai:needs-human
```

Do not install `agent:*` aliases unless the deployed runtime is configured to use them. `ai:todo` is the pickup label. Human recovery removes `ai:needs-human`; the retained `ai:running` label allows retry.

`production:diagnose` is a separate intake label for the read-only diagnostic identity. The coding listener does not consume it.

## Required environment

- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`
- `GITHUB_BASE_BRANCH=stage`
- `MAX_CONCURRENT_RUNS=1`
- `CODEX_AUTH_MODE=broker`; direct API-key/subscription modes and listener-level `OPENAI_API_KEY` fail startup
- `CODEX_BROKER_URL` as an exact credential-free `http(s)://.../v1` URL, `CODEX_BROKER_AUDIENCE`, and a 32+ character `CODEX_BROKER_SIGNING_SECRET`
- `CODEX_BROKER_TOKEN_TTL_SECONDS=1800` by default, bounded to 60–3600 seconds
- `CODEX_MODEL`, `CODEX_REASONING_EFFORT`
- `SANDCASTLE_IMAGE` pinned to a version/digest
- `REQUIRE_PINNED_IMAGES=true`
- `SANDCASTLE_BUILD_LOCAL=false`
- `HARNESS_DATA_DIR=/opt/issue-harness/<owner>-<repository>` (a unique, non-symlinked per-repository child) bind-mounted to the identical container path
- `DOCKER_HOST=unix:///run/sandbox-engine/docker.sock` for the dedicated rootless daemon, or a `tcp://` endpoint with `DOCKER_TLS_VERIFY=1` and per-listener client certificates under `$HARNESS_DATA_DIR/docker-certs`
- `SANDBOX_NETWORK` names a pre-created Docker internal network shared only with the broker; no default or external network is allowed
- bounded `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `SANDBOX_PIDS_LIMIT`, `SANDBOX_TMPFS_MB`, and `SANDBOX_MAX_OUTPUT_BYTES`
- for a private sandbox package, `SANDBOX_REGISTRY_SERVER`, `SANDBOX_REGISTRY_USERNAME`, and a read-only package token; never reuse a package-write or repository token
- `HEALTH_PORT=3000`
- `HARNESS_HEALTH_DETAILS_TOKEN` is optional at runtime, must contain at least 32 characters when set, and is required for online repository-identity verification. Pass the same secret to `verify_agent.py` as `AGENT_HEALTH_TOKEN`; never place it in CLI arguments, inventory, or output.

## Operational endpoints

- `GET /live` is process liveness only and drives the container restart healthcheck.
- `GET /ready` is readiness only: it fails until the first successful GitHub poll and when that dependency evidence becomes stale.
- `GET /health/worker` must match `assets/contracts/worker-health-v1.schema.json` exactly: `schemaVersion=1`, `status=healthy|stale`, nullable `lastHeartbeatAt`/`ageMs`, and mandatory exact `activity={poll,run}` with `poll=waiting|polling` and `run=idle|running`. Healthy verification requires a current non-null timestamp and bounded integer age; capacity short-circuits still advance the heartbeat.
- `GET /identity` returns repository and credential-free workspace origin only after an exact bearer-token match; it is `404` when no details token is configured.
- `GET /diagnostics` uses the same bearer token, exposes only readiness and heartbeat status, never repository data or secrets, and is `404` when disabled.

Online verification accepts one operator-controlled HTTPS origin and derives these fixed paths. Redirects, ambient proxies, credentials in URLs, query strings, fragments, non-200 responses, and responses over 4 KiB are rejected.

## Trust boundaries

- Raw rootful `/var/run/docker.sock` is unsupported. Use a dedicated rootless daemon socket or a mutually authenticated remote TLS daemon on an isolated automation host.
- Named volumes are incompatible with Sandcastle's bind-path contract. Use the same absolute `HARNESS_DATA_DIR` inside the listener and on the selected daemon host so child containers see only throwaway run paths.
- Create the data root and log, state, sandbox, workspace, run, artifact, publisher, and Docker-certificate directories as owner-only `0700`; repair drift on startup. Docker TLS certificate files are `0600`, owned by the agent identity, and regular non-symlink files. No persistent sandbox auth or Codex home is permitted.
- Ignore all runtime material in Git and Docker build contexts. Under `.harness/`, only declarative `config.json` plus the reviewed `coolify_client.py` and `deploy_exact_revision.py` helpers are trackable; `.env.example`, `.sandcastle/Dockerfile`, and `.sandcastle/prompt.md` are the corresponding explicit safe exceptions.
- The coding sandbox receives empty `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH` values and never receives the daemon socket mount.
- Keep the Git remote credential-free; inject auth only into the git child process.
- Never expose Coolify deploy credentials or production database credentials to the coding sandbox.
- Comments are untrusted instructions. Restrict who may apply `ai:todo`, prefer private repositories, and keep repository policy in the prompt.
- The runtime accepts issues/comments only from owner/member/collaborator associations, rejects repository-controlled `.sandcastle/.env`, and strips secret-shaped outer process variables while Sandcastle resolves its environment.
- The listener mints a per-run HS256 JWT (`iss=issue-harness`, exact `aud`, repository `sub`, issue, unique `jti`, `iat`, `exp`) and exposes it as the sandbox's temporary OpenAI-compatible bearer token. A new per-run `CODEX_HOME` is mounted and deleted afterward. The broker validates signature/issuer/audience/expiry/replay and alone holds upstream credentials.
- Broker-only containment is an explicit external contract, not a complete security proof. Broker provisioning, internal-network creation, upstream spend/rate policy, audit, and `jti` replay protection must be verified separately; missing controls fail startup. The sandbox still processes attacker-controlled repository and issue content, so use private repositories and trusted issue authors.
- Broker-only migration is fail-closed: if legacy `$HARNESS_DATA_DIR/auth` or `$HARNESS_DATA_DIR/codex` exists, securely archive or remove it before startup. The harness never auto-deletes credential material. A kernel `process.lock` prevents a second listener process, `runtime.lock` serializes TypeScript runtime operations, and immutable `repository-identity.json` binds the data directory to one repository.
- The sandbox writes only its throwaway clone. It produces a content-addressed patch/manifest after path/type/size/secret checks. A trusted publisher with GitHub credentials independently clones the current base, verifies hashes/base, applies with `git apply --check`, commits, and pushes; the sandbox never performs publication.
- Pin the canonical harness and sandbox GHCR coordinates to digests. Verify GitHub attestations for both against `refs/heads/main`, the same canonical repository, full source commit, and publication run, then prove those exact subjects are the running rollout. A version label may only alias that already verified digest; it is never a trusted rebuild source. Do not deploy `latest`, a fork coordinate, mixed-source images, or an unverified digest.
- One replica/concurrent run is required until distributed claiming and leases are implemented.

## Production diagnostics

Use a separate identity and an external log/telemetry backend. Allowed defaults: `health.read`, `logs.query`, `traces.query`, `metrics.query`, `deploy.status`. Mutations require typed runbooks, separate executor credentials, explicit approval, preconditions, rollback, and audit output.
