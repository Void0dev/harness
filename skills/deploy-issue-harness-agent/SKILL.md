---
name: deploy-issue-harness-agent
description: Install GitHub Issue intake for a target repository and deploy or repair one isolated issue-harness agent on Coolify, including runtime-compatible labels, issue forms, prompt contract, persistent checkout/state, credentials, sandbox configuration, health checks, and listener verification. Use when adding the issue-listening tooling or making the Coolify harness agent operational.
---

# Install Issue Harness on Coolify

Install one isolated listener per target repository. The agent turns `ai:todo` issues into branches and pull requests targeting `stage`.

## Required guidance

Read `references/agent-contract.md` and `references/image-release.md`. When production logs or diagnosis are requested, also read `references/production-diagnostics.md`. Read the target `.harness/config.json`, repository instructions, and Coolify resource inventory. Invoke `$setup-coolify-cicd` first when the target lacks its repository contract, `stage`/`main`, or Coolify project bindings.

## Preconditions

- The target has `stage` and `main`; `GITHUB_BASE_BRANCH` is `stage`.
- The harness and sandbox refs are immutable images from the same trusted canonical source commit published only from `refs/heads/main`. Version tags may alias an already verified main-built digest but may never rebuild it. Resolve the exact GHCR coordinates and digests through `references/image-release.md`; do not depend on files outside this installed skill.
- The sandbox image is pinned; reject `latest`.
- A dedicated Coolify automation server/destination is available with either a separate rootless Docker daemon or a mutually authenticated remote TLS Docker daemon. Raw `/var/run/docker.sock` is unsupported.
- Exactly one agent instance serves this repository; concurrency is `1` until a distributed lease exists.
- GitHub credentials are repository-scoped. The coding agent receives no production deploy/write credentials.
- Untrusted coding is broker-only. `CODEX_AUTH_MODE=broker`; a compatible broker and pre-created internal `SANDBOX_NETWORK` exist before the listener starts. Direct API-key and subscription modes are unsupported.
- Before a broker-only upgrade, the operator has securely archived or removed legacy `$HARNESS_DATA_DIR/auth` and `$HARNESS_DATA_DIR/codex`. Startup deliberately fails closed while either credential directory exists; the harness never auto-deletes credential material.
- The current runtime accepts issues and follow-up comments only from GitHub owner/member/collaborator associations. Do not weaken this for public intake without a separate approval and prompt-sanitization boundary.

## Workflow

1. Inspect existing labels, issue forms, listener resources, credentials by name, persistent volumes, and agent health. Do not print secret values.
2. Adapt `assets/agent-task.yml` and `assets/prompt.md` into the target repository. When production diagnosis is in scope, also install `assets/production-incident.yml`, bind the `production:diagnose` label, and keep its executor separate from the coding listener. Preserve compatible user content.
3. Plan or create the exact runtime labels:

   ```bash
   python3 <skill-dir>/scripts/github_labels.py owner/repo plan
   python3 <skill-dir>/scripts/github_labels.py owner/repo apply --allow-external-writes
   ```

4. Choose the sandbox engine boundary. Use `assets/coolify-agent-compose.yml` with `SANDBOX_DOCKER_SOCKET` pointing to a dedicated rootless daemon socket, or `assets/coolify-agent-compose.remote.yml` with a mutually authenticated `SANDBOX_DOCKER_HOST`. Remote mode requires the identical `HARNESS_DATA_DIR` on the daemon host because Sandcastle uses bind mounts. Raw `/var/run/docker.sock` is rejected at startup. Pre-create `SANDBOX_NETWORK` as Docker `--internal` and attach only the broker and transient sandboxes; the sandbox gets no default/external network. Set a unique non-symlinked `HARNESS_DATA_DIR=/opt/issue-harness/<owner>-<repository>`, repository identity, `MAX_CONCURRENT_RUNS=1`, explicit resource/output bounds, and the expected rootless daemon ID or remote TLS certificate path. Treat kernel `process.lock`, operation-level `runtime.lock`, and immutable `repository-identity.json` as repository-scoped state; never copy them into another repository's data directory.
5. Create or reconcile `harness-<owner>-<repo>` in a Coolify `automation` environment. Prefer API reconciliation when the installed Coolify exposes a documented Compose endpoint; otherwise use the authenticated Coolify UI. Never invent an unsupported endpoint.
6. Bind a repository-scoped fine-grained GitHub token, broker contract, and two canonical attested image subjects. Both images must be `ghcr.io/void0dev/{issue-harness,sandcastle-harness}@sha256:...`, originate from the same full commit of `https://github.com/Void0dev/harness`, and share one publication workflow run. Configure `CODEX_BROKER_URL` as an exact internal `/v1` URL, a bounded audience, and a 32+ character signing secret. The listener mints a 60–3600 second HS256 JWT per run; the broker validates signature, issuer, audience, expiry and `jti`, then holds the upstream credential outside the sandbox. A static GitHub App installation token is unsupported because it expires; use it only with an installed refresh/minting sidecar. Configure package-read-only registry credentials independently from the repository token.
7. Configure port `3000`, container liveness path `/live`, and a persistent volume. Bind a dedicated 32+ character `HARNESS_HEALTH_DETAILS_TOKEN`; provide the same value to the verifier only as `AGENT_HEALTH_TOKEN`. Start one replica. `/ready` proves a fresh successful GitHub poll. `/health/worker` must match `assets/contracts/worker-health-v1.schema.json` exactly, including mandatory `activity.poll=waiting|polling` and `activity.run=idle|running`, and proves the polling loop is still ticking even at capacity. Token-protected `/identity` proves the target repository. `/diagnostics` uses the same token, returns only bounded status fields, and is disabled when the token is absent.
8. Write only verified non-secret bindings to the `issueAgent` section of `.harness/config.json`, including `sandboxEngineMode=rootless-local|remote-tls`, canonical image subjects, `imageSourceRepository`, full `imageSourceCommit`, and `imagePublicationRunId`.
9. Copy `assets/inventory-values/agent-rollout.values.example.json`, replace every `null` from fresh read-only Coolify observation, then generate the exact short-lived rollout envelope:

   ```bash
   python3 <skill-dir>/scripts/generate_agent_inventory_fixture.py \
     --values-json /tmp/agent-rollout.values.json \
     > /tmp/fresh-coolify-agent-inventory.json
   ```

10. Download each OCI index manifest and GitHub attestation bundle on an online evidence host, and refresh `trusted_root.jsonl` with `gh attestation trusted-root`. Transfer those files together; do not put signed-bundle success booleans in rollout inventory. Run the verifier offline for provenance while it probes the supplied HTTPS operational origin:

   ```bash
   AGENT_HEALTH_TOKEN=... python3 <skill-dir>/scripts/verify_agent.py <repo-root> \
     --health-origin https://harness.example.com \
     --inventory-json /tmp/fresh-coolify-agent-inventory.json \
     --harness-manifest /evidence/issue-harness-index.json \
     --sandbox-manifest /evidence/sandcastle-index.json \
     --harness-attestation-bundle /evidence/issue-harness-attestation.jsonl \
     --sandbox-attestation-bundle /evidence/sandcastle-attestation.jsonl \
     --trusted-root /evidence/trusted_root.jsonl \
     --source-ref refs/heads/main
   ```

11. Rollout inventory is schema v1 with a generated UUID and at most ten-minute window. It contains only application/server/data/replica bindings, configured image subjects, exact running rollout subjects/status, and `source=coolify-api|coolify-ui`. Cryptographic provenance is a separate offline proof: `gh attestation verify` binds local OCI manifest bytes to the configured digest and bundle, canonical repository and signer workflow, trusted source ref and commit, GitHub-hosted runner, and configured publication run. Then verify liveness, readiness, worker heartbeat, token-protected repository identity, exact labels, and single-listener state. For an explicitly authorized E2E smoke, create a uniquely marked test issue, observe pickup, content-addressed artifact, trusted publisher branch, and draft PR; clean up only smoke-owned artifacts.

## Production diagnostics

The coding listener is not the production operator. If production diagnosis is requested, bind a separate read-only adapter for health/log/trace/metric/deploy-status queries and configure `productionAgent.mode=diagnose-only`, `mutationPath=none`, and only the allowlisted read tools in `.harness/config.json`. It may not receive shell, SSH, SQL write, Coolify `write`/`deploy`, or application credentials. Log-drain setup is UI-only in the documented Coolify surface; report it as unbound until verified.

After binding an adapter that implements the contract, run the verifier with operator-controlled endpoints, for example:

```bash
DIAGNOSTICS_TOKEN=... python3 <skill-dir>/scripts/verify_diagnostics.py <repo-root> \
  --allowed-origin https://diagnostics.example.com \
  --health-url https://diagnostics.example.com/health \
  --query-url https://diagnostics.example.com/v1/logs/query \
  --policy-check-url https://diagnostics.example.com/v1/policy/check \
  --credential-env DIAGNOSTICS_TOKEN
```

If no adapter/provider was selected, finish the coding-agent installation and report production diagnostics as a separate unbound capability.

## Completion claims

Claim `issue-agent-online` only after one verifier run proves both signed image subjects, exact running rollout, `/live`, `/ready`, `/health/worker`, and token-protected `/identity` from the fixed HTTPS origin. Claim `issue-listener-e2e` only after a controlled issue crosses sandbox → content-addressed artifact → trusted publisher → branch/PR. Never claim production-log access unless a bounded redacted query succeeds and a write/deploy denial probe also succeeds.
