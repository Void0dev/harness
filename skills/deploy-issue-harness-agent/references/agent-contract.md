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
- `CODEX_AUTH_MODE=api-key|subscription`
- `OPENAI_API_KEY` only for API-key mode
- `CODEX_MODEL`, `CODEX_REASONING_EFFORT`
- `SANDCASTLE_IMAGE` pinned to a version/digest
- `REQUIRE_PINNED_IMAGES=true`
- `SANDCASTLE_BUILD_LOCAL=false`
- `HARNESS_DATA_DIR=/opt/issue-harness/<owner>-<repository>` (a unique, non-symlinked per-repository child) bind-mounted to the identical container path
- for a private sandbox package, `SANDBOX_REGISTRY_SERVER`, `SANDBOX_REGISTRY_USERNAME`, and a read-only package token; never reuse a package-write or repository token
- `HEALTH_PORT=3000`

## Trust boundaries

- Raw Docker socket grants host-level control. Put this service on a dedicated automation host.
- Named volumes are incompatible with the host-socket sandbox path contract. Use the same absolute bind path inside and outside the listener so child containers see the target checkout and Codex home.
- Keep the Git remote credential-free; inject auth only into the git child process.
- Never expose Coolify deploy credentials or production database credentials to the coding sandbox.
- Comments are untrusted instructions. Restrict who may apply `ai:todo`, prefer private repositories, and keep repository policy in the prompt.
- The runtime accepts issues/comments only from owner/member/collaborator associations, rejects repository-controlled `.sandcastle/.env`, and strips secret-shaped outer process variables while Sandcastle resolves its environment.
- Codex authentication is still readable inside an outbound-network sandbox because the CLI needs it. Use a dedicated low-blast-radius Codex identity, private repositories, trusted issue authors, spend/rate limits, and provider audit. For stronger isolation, require an egress allowlist or credential broker before installation.
- Pin the harness image and sandbox image. Do not deploy `latest`.
- One replica/concurrent run is required until distributed claiming and leases are implemented.

## Production diagnostics

Use a separate identity and an external log/telemetry backend. Allowed defaults: `health.read`, `logs.query`, `traces.query`, `metrics.query`, `deploy.status`. Mutations require typed runbooks, separate executor credentials, explicit approval, preconditions, rollback, and audit output.
