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
- The harness and sandbox refs are immutable images from the same trusted canonical source commit. Resolve their exact GHCR coordinates and digests through `references/image-release.md`; do not depend on files outside this installed skill.
- The sandbox image is pinned; reject `latest`.
- A dedicated Coolify automation server/destination is available. If the runtime mounts raw `/var/run/docker.sock`, refuse co-location with production workloads.
- Exactly one agent instance serves this repository; concurrency is `1` until a distributed lease exists.
- GitHub credentials are repository-scoped. The coding agent receives no production deploy/write credentials.
- The current runtime accepts issues and follow-up comments only from GitHub owner/member/collaborator associations. Do not weaken this for public intake without a separate approval and prompt-sanitization boundary.

## Workflow

1. Inspect existing labels, issue forms, listener resources, credentials by name, persistent volumes, and agent health. Do not print secret values.
2. Adapt `assets/agent-task.yml` and `assets/prompt.md` into the target repository. When production diagnosis is in scope, also install `assets/production-incident.yml`, bind the `production:diagnose` label, and keep its executor separate from the coding listener. Preserve compatible user content.
3. Plan or create the exact runtime labels:

   ```bash
   python3 <skill-dir>/scripts/github_labels.py owner/repo plan
   python3 <skill-dir>/scripts/github_labels.py owner/repo apply --allow-external-writes
   ```

4. Adapt `assets/coolify-agent-compose.yml` for immutable harness and sandbox image digests. Set `HARNESS_DATA_DIR=/opt/issue-harness/<owner>-<repository>` to a unique, non-symlinked per-repository directory and bind the identical host path into the listener; a named volume does not work with host-socket child containers. Set `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH=stage`, `MAX_CONCURRENT_RUNS=1`, and `CODEX_AUTH_MODE` explicitly.
5. Create or reconcile `harness-<owner>-<repo>` in a Coolify `automation` environment. Prefer API reconciliation when the installed Coolify exposes a documented Compose endpoint; otherwise use the authenticated Coolify UI. Never invent an unsupported endpoint.
6. Bind a repository-scoped fine-grained token, Codex credentials, and the two pinned image digests. A static GitHub App installation token is unsupported because it expires; use it only when a refresh/minting sidecar is actually installed. Subscription auth may require an explicit credential/device-login step and must use persistent Codex home. Configure Coolify's registry credential for a private top-level harness image. If the sibling sandbox image is private, separately bind `SANDBOX_REGISTRY_SERVER`, `SANDBOX_REGISTRY_USERNAME`, and a read-packages-only `SANDBOX_REGISTRY_TOKEN`; startup logs in only for the host-Docker pull and then logs out. Public sandbox images need no registry credential.
7. Configure port `3000`, health path `/health`, and a persistent volume. Start one replica.
8. Write only verified non-secret bindings to the `issueAgent` section of `.harness/config.json`.
9. Run:

   ```bash
   python3 <skill-dir>/scripts/verify_agent.py <repo-root> \
     --health-url https://harness.example.com/health \
     --inventory-json /tmp/fresh-coolify-agent-inventory.json
   ```

10. Build the inventory JSON from a fresh read-only Coolify API/UI inspection. It must contain exactly the scalar fields `applicationUuid`, `serverUuid`, `harnessImage`, `sandboxImage`, `dataDir`, `replicas`, `observedAt`, and `source`; `source` is `coolify-api` or `coolify-ui`, and `observedAt` is a timezone-aware ISO-8601 timestamp no older than ten minutes. Never add secrets or arbitrary fields. Verify container health, repository identity, target checkout origin, prompt loading, exact labels, and single-listener state. For an explicitly authorized E2E smoke, create a uniquely marked test issue, observe pickup, branch, and draft PR, then clean up only artifacts created by that smoke.

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

Claim `issue-agent-online` only after `/health` returns the expected repository. Claim `issue-listener-e2e` only after a controlled issue reaches a branch/PR. Never claim production-log access unless a bounded redacted query succeeds and a write/deploy denial probe also succeeds.
