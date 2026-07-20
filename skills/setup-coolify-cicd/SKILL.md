---
name: setup-coolify-cicd
description: Prepare a Convex, NestJS/PostgreSQL, or hybrid repository for deployment and create or repair its complete Coolify delivery setup with stage mapped to staging and main mapped to gated production. Use when onboarding a project to Coolify, making a repository deployment-ready, or configuring stage/production CI/CD, branches, environments, databases, health checks, and deployment workflows.
---

# Set Up Project on Coolify

Own the complete project-onboarding path: first make the repository deployable, then bind two independent Coolify applications: `stage` to staging and `main` to production. Do not install the issue listener; `$deploy-issue-harness-agent` owns that second product.

## Modes

- `plan`: inspect local desired state only, perform no external access, and report resolved/unresolved application, PostgreSQL, Convex, and approval actions.
- `apply`: make repository changes and reconcile already-authorized GitHub/Coolify resources.
- `repair`: inventory drift, then update only fields owned by this skill.
- `verify`: make no changes and re-prove local readiness and external bindings.

Default a clear setup request to `apply`. Never perform the first production deployment, rotate secrets, replace a database, or weaken protection without explicit authority.

## 1. Prepare the repository

1. Read repository instructions, Git status, manifests, lockfiles, Docker/deployment files, workflows, health endpoints, migrations, and existing `.harness/` files.
2. Run `python3 <skill-dir>/scripts/doctor.py <repo-root> --json`, then read `references/readiness-contract.md`. Resolve every deployable root and declare the detected capabilities independently. A hybrid project composes `coolify.application`, `coolify.postgresql`, and `convex.deployment`; it is not a separate mutually exclusive profile.
   If the repository still uses schema v1, first run `python3 <skill-dir>/scripts/migrate_harness.py <repo-root> --dry-run`. Review the reported paths and SHA-256 hashes, then use `--write` to replace the config and five canonical workflows from the same canonical contract. Dry-run is side-effect free and never prints the config body.
3. Reuse existing commands and dependencies. Define separate required install, test, lint, typecheck, build, and smoke commands; none may be optional or use `--if-present`. Each PostgreSQL or Convex capability owns its non-mutating check and lane-specific deploy commands.
4. Add or repair:
   - `.harness/config.json` using `assets/config.example.json` as its shape;
   - a deterministic Docker/build contract and health endpoint;
   - sanitized `.env.example` variable names without credential values;
   - five canonical workflows through the shared compiler: `.github/workflows/ci.yml`, `coolify-deploy.yml`, `backend-prepare.yml`, `coolify-rollback.yml`, and `bootstrap-deployment-evidence.yml`; never hand-assemble fragments or keep a second compiler;
   - protected rollback and bootstrap workflows that accept only attested evidence locators, never a raw rollback revision;
   - `.harness/coolify_client.py` and `.harness/deploy_exact_revision.py`, copied byte-for-byte from the corresponding reviewed assets;
   - a fail-closed ignore boundary: ignore `.harness/*` and re-include only `config.json`, `coolify_client.py`, and `deploy_exact_revision.py`; ignore every non-example `.env*`, credential file, and local `.omx/` state; exclude the same material from Docker build contexts;
   - explicit stdout/stderr logging and environment completeness.
5. Run project checks and `python3 <skill-dir>/scripts/doctor.py <repo-root> --json --run-commands`. Do not continue to external setup while local readiness errors remain.

## 2. Bind GitHub and Coolify

Read `references/coolify-api.md`. Verify the GitHub repository and visibility; Coolify URL, project/server/GitHub App UUIDs; service root/build pack; ports/health path; and distinct stage/production domains and stateful backends. Never guess an external value.

1. Inspect branches, rules, GitHub environments/secrets, Coolify environments/applications/databases, and domains before mutation.
2. Create `stage` from `main` only when absent. Never reset or force-push either branch.
3. Create or bind separate Coolify `stage` and `production` environments, applications, domains, credentials, and data backends. For PostgreSQL, use two resources, actual UUIDs, distinct credential references, and readiness evidence. For Convex, use two permanent deployments in separate projects with distinct deployment-scoped key references. Hybrid requires both complete sets.
4. Compile `.github/workflows/coolify-deploy.yml` from the declared capability graph. The shared compiler merges the matching Convex and/or PostgreSQL jobs, JSON/YAML-encodes every command as a string scalar, substitutes reviewed runners, and makes deploy depend on every required gate. The validator parses the result, verifies exact command semantics, and byte-compares the installed result with that same compiler output.
   Production backend preparation is a separate compiler output: `workflow_compiler.compile_backend_prepare_workflow(...)` consumes only internal assets `backend-prepare.yml`, `backend-prepare-postgres.yml`, and `backend-prepare-convex.yml`. It runs in the protected `production` environment and serializes PostgreSQL before Convex for hybrid. Initial preparation emits sequence-0 `backend-release-v1`; later preparation accepts only the optional `previous_backend_evidence_run_id`, `previous_backend_evidence_artifact_id`, and `previous_backend_evidence_artifact_name` chain locator. Production deploy consumes the resulting backend locator directly and publishes `consumption-v1`; mutable repository/environment evidence variables are not authoritative.
5. Record exact reviewed gate runner labels in `deployment.gateRunners`. Use `ubuntu-latest` unless a private database requires a dedicated self-hosted runner. Do not accept runner expressions, extra jobs/actions/triggers, permission escalation, `continue-on-error`, `always()`, or unresolved `__HARNESS_*` placeholders.
6. Generate a non-mutating plan:

   ```bash
   python3 <skill-dir>/scripts/coolify_reconcile.py <repo-root> plan
   ```

   The report must contain `externalAccess: false`, `actions`, `backendActions`, and `approvalActions`. Unbound values stay unresolved; plan never requires `COOLIFY_URL`, a token, inventory, or network. Production reports `contractMigration: separate-post-application-approval-only` rather than pretending a backend is ready.

   Generate a typed fresh inventory only after separate read-only observation. Copy the matching redacted values template from `assets/inventory-values/`, replace every `null`, then run:

   ```bash
   python3 <skill-dir>/scripts/generate_inventory_fixture.py \
     --profile application|nest-postgres|convex|hybrid \
     --values-json /tmp/operator.values.json \
     > /tmp/fresh-inventory.json
   ```

   The generator creates `inventoryId`, `observedAt`, and `expiresAt`, validates the exact profile schema, and prints no credentials.

7. With authorized credentials, reconcile resources:

   ```bash
   COOLIFY_URL=... COOLIFY_TOKEN=... \
   COOLIFY_TOKEN_SCOPES=read,write \
   COOLIFY_TOKEN_EXPIRES_AT="$TOKEN_EXPIRY_RFC3339" \
   COOLIFY_TOKEN_IP_ALLOWLISTED=true \
     python3 <skill-dir>/scripts/coolify_reconcile.py <repo-root> apply \
     --allow-external-writes --allow-production-writes \
     --production-approval-ref <non-secret-change-reference> \
     --inventory-json <fresh-inventory.json>
   ```

   The production flags are independent: a general external-write flag is insufficient. The command emits the non-secret approval reference and planned evidence requirements; rollback authority is never supplied as a raw SHA. Use fresh operator-controlled inventory for every existing application and stateful capability. Require `source`, timezone-aware `observedAt` no older than ten minutes, canonical application/database/Convex identity, explicit readiness, and SHA-256 fingerprints for existing application environment values. `deliveryEnvironments` must prove distinct GitHub Environment credential scopes plus production reviewers and self-review prevention. Convex inventory records the symbolic deploy-key reference and its deployment scope, never the key value. Never print raw values or fingerprints.
8. Configure GitHub environments `stage` and `production`. Store lane-specific resource UUID, HTTPS health URL, and only the capability secret required by that lane. Exact deployment uses two distinct short-lived Coolify credentials: `COOLIFY_PIN_TOKEN` with exactly `read,write`, and `COOLIFY_DEPLOY_TOKEN` with exactly `read,deploy`. Store the matching non-secret scopes, expiry, and IP-allowlist assertions as environment variables. Reconciliation uses a separate `COOLIFY_TOKEN` with exact scopes for its mode. Require review for production when supported; do not weaken existing rules.
9. Require Coolify `>= 4.1.2`. Disable source auto-deploy when GitHub Actions owns deployment. For each lane, serialize on the resource UUID. Resolve current authority from an immutable locator `{repository, runId, artifactId, artifactName, fileName, sha256}`; verify artifact metadata, SHA-256, GitHub attestation, exact schema/bindings, trusted-main producer, live deployment UUID/commit/resource, current application pin, disabled auto-deploy, and health before PATCH. Production dispatch accepts `deployment_evidence_run_id`, `deployment_evidence_artifact_id`, and `deployment_evidence_artifact_name`; it additionally requires the backend evidence locator. Then PATCH the full target commit, re-read it, trigger exactly one deployment, poll/assert exact commit and pin, and probe health. Publish a successor `deployment-success-v1` only after success. Every post-pin failure automatically compensates to the verified predecessor; if compensation also fails, emit `ROLLBACK_FAILED`. Missing or expired evidence fails before mutation. Deploy and smoke-test staging. Dry-verify production; leave its first deployment gated.
10. Verify the workflow and external state:

    ```bash
    python3 <skill-dir>/scripts/validate_workflow.py <repo-root>
    COOLIFY_URL=... COOLIFY_TOKEN=... \
      python3 <skill-dir>/scripts/coolify_reconcile.py <repo-root> verify \
      --inventory-json <fresh-inventory.json>
    ```

## Safety and claims

- `harness_config.py` is the compatibility facade for schema loading and v1-to-v2 normalization; `workflow_compiler.py` owns exact workflow generation; `harness_evidence.py` owns typed reconciliation evidence. The repository-level contract is byte-identical in the setup skill and deploy skill package, while the deploy skill carries its own agent-evidence verifier so it remains independently installable.
- Schema v1 is a read-only compatibility alias. Canonical v2 output removes `project.stack`, legacy migration/backend command keys, and `coolify.stage`/`coolify.production`; their ownership moves to capability commands and lane bindings. An existing compatible delivery policy is preserved, including stricter reviewer counts; defaults apply only when the policy is absent.
- `harness_io.py` is the only repository writer for migration and reconciliation. It rejects symlinks in every destination, parent, and lock component; serializes writers; creates mode-`0600` same-directory temporaries; fsyncs; preserves modes; and replaces each destination atomically. Before replacement it durably writes the crash-recovery journal `.harness/write-journal-v1.json`; the next migration/reconciliation restores an interrupted prepared transaction before continuing and reports `recoveredInterruptedWrite`. Always review emitted hashes and Git diff.

- Privileged Coolify calls require HTTPS, deny redirects, ignore ambient proxies, cap timeouts/responses, and re-check token expiry. Reconciliation uses exact `read,write` (apply) or `read` (verify). Exact deployment splits pin (`read,write`) from trigger/poll (`read,deploy`). Every token expires within 24 hours. Scope, expiry and IP allowlist fields are an `operator assertion` (`evidenceSource: operator-assertion`) unless independently backed by signed/server policy evidence; never present them as server-verified. Never use `root` or `read:sensitive`.
- PATCH only managed drift. Update environment variables one key at a time; never bulk replace or silently rotate them.
- Never overwrite an occupied domain, delete/recreate persistent state, connect a coding agent to production credentials, or run a production migration outside the gated job.
- Every production reconciliation requires a protected-environment proof and external approval reference. Deployment/rollback authority comes only from verified GitHub artifact locators and attestations; no raw revision is accepted. Reconciliation does not mutate PostgreSQL or Convex. Those mutations require the separately compiled protected prepare workflow and attested `backend-release-v1` handoff; absent that contract, fail closed. Application rollback never rewinds or recreates a stateful backend.
- Bootstrap is explicit. `bootstrap-deployment-evidence.yml` accepts `lane`, `mode=import-existing|initialize-empty`, `resource_uuid`, and `health_url`; import also requires `expected_revision` and `existing_deployment_uuid`. Import verifies live state and emits sequence-0 `deployment-success-v1`. Initialize-empty emits non-authorizing `empty-observation-v1` and performs no mutation; normal delivery remains blocked until a separate protected operator/provider initial deployment is verified by `import-existing`.
- Manual rollback accepts only `target_evidence_run_id`, `target_evidence_artifact_id`, and `target_evidence_artifact_name`. It derives the target revision from the verified historical record and publishes a new chain head.
- GitHub artifact retention is a hard availability boundary. Missing, deleted, expired, malformed, or unattested evidence fails closed; use a retention-locked append-only archive/checkpoint when rollback requirements exceed GitHub retention.
- Do not restore the old inline `curl /deploy` workflow. The reviewed helper enforces the Coolify minimum version and pin→trigger→poll→assert order; workflow and local file locks are both per resource.
- All remote Actions use reviewed full commit SHA pins. CI must byte-match the compiled template, use only `contents: read`, and run install → test → lint → typecheck → build without optional gates.
- Claim `repo-ready` only after fresh doctor and project checks pass.
- Claim `cicd-bound` only after fresh GitHub/Coolify/Convex inventory proves distinct applications, domains, environments, credentials, and every declared backend capability.
- Claim `stage-healthy` only after a fresh immutable deployment and HTTP smoke pass.
- Claim `production-configured`, not `production-live`, until an authorized production deployment succeeds.
