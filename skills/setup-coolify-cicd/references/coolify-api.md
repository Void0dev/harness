# Coolify API contract

Use `Authorization: Bearer <token>` against an HTTPS `<COOLIFY_URL>/api/v1` origin. Userinfo, base paths, query strings, fragments, redirects, and ambient proxy settings are rejected. Responses are bounded to 1 MiB and requests to 30 seconds; errors never echo response bodies.

Permissions: `read` reads resources, `read:sensitive` additionally exposes secret/log values, `write` mutates resources, `deploy` starts deployments, and `root` bypasses access controls. Use the exact least-privilege set for each phase. Pinning and deployment deliberately use two tokens so neither one has `read+write+deploy`; all credentials expire within 24 hours. The current scope/expiry/IP-allowlist evidence is an operator assertion, not a signed Coolify policy response, and is reported as `evidenceSource: operator-assertion`.

Documented endpoints used by this skill:

- `GET /projects/{project_uuid}/environments`
- `POST /projects/{project_uuid}/environments` with `{ "name": "stage" }`
- `GET /applications`
- `POST /applications/private-github-app`
- `PATCH /applications/{application_uuid}`
- `GET /applications/{application_uuid}/envs`, then `POST /applications/{application_uuid}/envs` for one missing key at a time
- `POST /databases/postgresql` to create a missing PostgreSQL resource; re-list/re-inventory after creation because the documented response does not reliably return the new UUID
- `POST`/`PATCH /applications/{application_uuid}/envs` for one variable at a time
- `GET /deploy?uuid={application_uuid}` to start a deployment
- `GET /deployments/{deployment_uuid}` to inspect status
- `GET /version` to enforce Coolify `>= 4.1.2`

`GET /applications/{uuid}` uses response fields such as `fqdn`, `environment_id`, and `destination_id`; they do not directly mirror create inputs like `domains`, `environment_name`, and `server_uuid`. Use `fqdn` as the domain read alias and require an operator-generated canonical inventory before adopting or mutating an existing application. Do not infer project/environment/server identity from missing response fields.

Canonical inventory is a separate operator-controlled assertion. Its metadata includes `inventoryVersion: 1`, a canonical UUID `inventoryId`, `observedAt`, and an `expiresAt` no more than ten minutes later; expired inventories fail closed. Database records include `databaseType: "postgresql"`, lane identity, `ready: true`, and `readinessSource: "coolify-health"`. Existing application variables include `applicationUuid`, `key`, and `valueSha256`; compute the fingerprint from the exact lane-specific value outside the repository and never store or print the value itself.

Convex is not a Coolify database resource. For each declared `convex.deployment` capability, add two `convexDeployments` records from a fresh read-only Convex inspection. Each record contains only `capabilityId`, `lane`, `projectRef`, `deploymentRef`, `deploymentType: "permanent"`, the symbolic `deployKeyRef`, `deployKeyScope` equal to that deployment, `ready: true`, and `readinessSource: "convex-deployment"`. Never place a deploy key or its fingerprint in inventory. Hybrid verification fails unless both PostgreSQL and Convex sections are complete.

`deliveryEnvironments` is the GitHub-side policy inventory. It contains one record per lane with `lane`, `environmentName`, protected `branch`, and a lane-specific `credentialScope`. Production additionally proves `requiredReviewers` and `preventSelfReview`. It contains no secret names or values. A production Coolify reconciliation is refused without this proof, a separate production-write flag, and an external approval reference. Deployment authority arrives later through verified evidence locators, never through a raw rollback SHA.

Coolify does not document API mutation endpoints for server log-drain configuration. Configure log drains in the UI and verify them separately; do not pretend the CI/CD setup configured observability.

The deployment status schema does not publish an exhaustive terminal-state enum. Treat `finished`, `success`, and `completed` as success; `failed`, `error`, and `cancelled` as failure; time out on unknown states without mutating production.

Controlled Git deployments use this serialized contract under a per-resource lock. First resolve `{repository, runId, artifactId, artifactName, fileName, sha256}`, verify artifact metadata/SHA-256 and its GitHub attestation, validate exact `deployment-success-v1`, and remotely re-check its deployment UUID, commit, resource UUID, current application pin, disabled auto-deploy, and health. Only then `PATCH /applications/{uuid}` with the target full `git_commit_sha` and `is_auto_deploy_enabled: false`; re-read both fields; `POST /deploy` with exactly one UUID; require one queue record; poll its deployment UUID; require the full commit; re-read the pin; and probe readiness. Publish the successor success record only after all checks pass. Any post-pin failure compensates to the verified predecessor; a failed compensation emits `ROLLBACK_FAILED`. A runner-local file, latest variable, branch, short SHA, queue acceptance, or status without exact commit is not authority.

The reviewed `assets/coolify-rollback.yml` is the separate protected manual recovery path. It runs only on `main` in the `production` environment and accepts `target_evidence_run_id`, `target_evidence_artifact_id`, and `target_evidence_artifact_name`; there is no raw revision input. It derives the target SHA only after verifying the historical artifact/attestation and live bindings, then publishes a new successor record. Both delivery and rollback workflows inject operator-controlled resource UUID and health URL through step environment variables and quote them in the shell; direct expression interpolation into a command is forbidden.

The reconciler never mutates PostgreSQL or Convex. Production backend changes use the separately compiled protected preparation workflow. Sequence 0 is explicit; later runs accept only the previous backend artifact locator. After deterministic PostgreSQL-then-Convex preparation, the workflow publishes attested `backend-release-v1`. Production deploy consumes `backend_evidence_run_id`, `backend_evidence_artifact_id`, and `backend_evidence_artifact_name`, then publishes `consumption-v1`. Missing, expired, unattested, already-consumed, or mismatched evidence is a refusal, not an implicit migration.

`bootstrap-deployment-evidence.yml` is the only bootstrap path. `import-existing` requires and live-verifies the exact revision/deployment UUID plus health and disabled auto-deploy before emitting sequence 0. `initialize-empty` proves `empty-observation-v1` and performs no mutation; normal delivery remains blocked until a separate protected operator/provider initial deployment is imported. The observation never authorizes rollback or acts as a predecessor. GitHub artifact retention is therefore operationally significant: expired or deleted evidence fails closed, and longer rollback horizons require a retention-locked append-only archive using the same attestation and live-readback rules.
