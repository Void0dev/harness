# Repository readiness contract

## Common contract

- Branch mapping: `stage` is persistent staging; `main` is production; agent PR base is `stage`.
- A lockfile exists and CI uses the matching frozen install command.
- Install, test, lint, typecheck, build, startup, health, and smoke commands are explicit single-line commands. Lint and typecheck are separate required gates; `--if-present` is forbidden.
- Remote Actions and reusable workflows are pinned to reviewed full 40-character commit SHAs; workflow token permissions remain minimal.
- The service emits logs to stdout/stderr and includes environment, service, source commit, and correlation ID where available.
- `/health` proves process liveness. A separate readiness route may verify required dependencies without exposing secrets.
- Docker images run a production command, define a healthcheck, and do not bake secrets.
- `.env.example` documents required variable names and safe examples only.
- `.harness/config.json` is declarative and contains no credential values.
- `deliveryPolicy.production` requires manual dispatch, at least one reviewer, and self-review prevention in the `production` GitHub Environment. `deliveryPolicy.rollback` routes an attested historical evidence locator through that same approval gate; no raw revision input is authoritative.
- `deployment.minimumCoolifyVersion` is `4.1.2` and `deployment.revisionStrategy` is `git-commit-sha`. The installed exact-revision helper must byte-match the reviewed asset.
- `coolify.apiPolicy` is fail closed: HTTPS only, no redirects, no ambient proxy, 30-second request ceiling, 1 MiB response ceiling, token TTL at most 24 hours, required IP allowlist, and separate pin/deploy credentials. Both installed helper files byte-match their reviewed assets.

## Capability graph

- Schema v2 declares a list of capabilities; `project.stack` is accepted only while reading schema v1.
- Normalize all consumers through `harness_config.load_config`. Canonical v2 contains no `project.stack`, legacy migration/backend keys in top-level `commands`, or `coolify.stage`/`coolify.production`; those values live only in capability commands and bindings.
- Every capability owns its root, detection rules, commands, exact stage/production bindings, workflow gates, evidence claims, and completion proof.
- `coolify.application` is required exactly once. `coolify.postgresql` and `convex.deployment` are optional and composable; a hybrid repository declares both.

## Canonical migration, workflows, and evidence

- Preview legacy normalization with `python3 <skill-dir>/scripts/migrate_harness.py <repo-root> --dry-run`. It reports only target paths, change flags, and SHA-256 hashes and performs no writes.
- Apply with the explicit `--write` mode. It writes canonical schema v2 plus five canonical workflows (`ci.yml`, `coolify-deploy.yml`, `backend-prepare.yml`, `coolify-rollback.yml`, `bootstrap-deployment-evidence.yml`) under a repository-local lock using per-file atomic replacements. A durable `.harness/write-journal-v1.json` captures originals before replacement; the next writer recovers an interrupted prepared transaction and reports `recoveredInterruptedWrite`.
- Do not hand-merge workflow fragments. `workflow_compiler.py` is the only compiler, emits configured commands as unambiguous JSON/YAML string scalars, and `validate_workflow.py` parses and compares installed workflows with its output. Its backend-prepare compiler consumes internal fragments only and serializes hybrid PostgreSQL before Convex under the protected production environment.
- `harness_evidence.py` defines the freshness envelope and exact typed records for applications, PostgreSQL databases, Convex deployments, GitHub delivery environments, and environment-variable fingerprints. Optional sections remain capability-dependent, but every supplied section rejects unknown fields and incorrect scalar types before reconciliation. Issue-agent rollout and cryptographic provenance stay in the independently installable deploy skill.
- The issue-agent and diagnostic verifiers are standalone: the deploy skill packages the byte-identical repository envelope contract plus a purpose-specific typed agent-evidence contract. Installing the deploy skill does not require a sibling setup skill directory.
- `harness_io.py` owns both migration and reconciliation writes. Every write/lock path rejects symlinked leaf or parent components before external reconciliation or filesystem mutation.

### Attested deployment evidence

- Public evidence locators have exact fields `{repository, runId, artifactId, artifactName, fileName, sha256}`. Workflows pass run/artifact coordinates; the resolver fixes repository/file name, verifies artifact metadata and digest, then verifies the raw `evidence.json` GitHub attestation from the exact trusted workflow and `refs/heads/main` producer before parsing it.
- Every record has exact `producer={runId,runAttempt,workflowPath,workflowRef,sourceRef,sourceSha,event}` and a linear `sequence`/`predecessor`. Multiple heads, missing artifacts, malformed records, wrong producers, and expired retention fail closed.
- `deployment-success-v1` is the only deploy/rollback/predecessor authority. It binds repository, lane, provider, resource UUID, revision, deployment UUID, health hash/verification, disabled auto-deploy, sequence/predecessor, target, producer, and successful outcome. Live Coolify read-back must still match.
- `backend-release-v1` aggregates deterministic PostgreSQL-then-Convex preparation receipts. Production consumes its locator alongside the current deployment locator and publishes `consumption-v1` linking both records to the resulting application revision.
- `bootstrap-deployment-evidence.yml` emits sequence 0. `import-existing` proves a live successful deployment. `initialize-empty` produces `empty-observation-v1` and performs no mutation; normal delivery remains blocked until a separate protected operator/provider initial deployment is imported. The empty record never authorizes deployment, rollback, or predecessor selection.
- Artifact retention limits rollback availability. Schedule checkpoint/archive before expiry when the required recovery horizon exceeds GitHub retention; absence or expiry is a refusal, never permission to infer state.

## Convex capability

- Use distinct permanent Convex deployments in distinct Convex projects for stage and production.
- Supply `VITE_*` values at frontend build time, not only container runtime.
- Keep deploy keys deployment-scoped and record distinct non-secret `deployKeyRef` values. Do not expose a production deploy key to the coding agent or inventory.
- Verify frontend build, Convex schema/functions, and stage deployment separately.
- Declare capability commands `check`, `deployStage`, and `deployProduction`. The readiness doctor runs only the non-mutating check; the environment-scoped delivery workflow owns deployments.
- Fresh `convexDeployments` evidence binds the capability/lane to `projectRef`, `deploymentRef`, `deploymentType: permanent`, symbolic `deployKeyRef`, `deployKeyScope`, and explicit readiness.

## PostgreSQL capability

- Use distinct stage and production PostgreSQL resources/databases and credentials.
- Store verified Coolify PostgreSQL UUIDs as each lane's `resourceRef` and distinct external secret names as `credentialRef`; descriptive strings are not evidence of separation.
- Make migrations an explicit gated job; do not hide production migrations in application startup.
- Health checks distinguish process liveness from database readiness.
- Document rollback/forward-fix behavior for each migration.
- Declare capability commands `check`, `deployStage`, and `deployProduction`. The readiness doctor runs only `check`; migrations execute as separately gated environment jobs, never during app startup.
- Fresh database evidence must prove the UUID, PostgreSQL type, Coolify project/server/environment identity, and `ready: true` from `coolify-health` for both lanes.

## Minimal `.harness/config.json`

Use schema v2 `assets/config.example.json` as the shape. Include only capabilities the repository actually needs. Replace detected local fields and keep unknown external resource/project bindings as `null` until verified; apply/verify refuses unresolved bindings.
