# Coolify API contract

Use `Authorization: Bearer <token>` against `<COOLIFY_URL>/api/v1`.

Permissions: `read` reads resources, `read:sensitive` additionally exposes secret/log values, `write` mutates resources, `deploy` starts deployments, and `root` bypasses access controls. Use the least privilege token for each phase.

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

`GET /applications/{uuid}` uses response fields such as `fqdn`, `environment_id`, and `destination_id`; they do not directly mirror create inputs like `domains`, `environment_name`, and `server_uuid`. Use `fqdn` as the domain read alias and require an operator-generated canonical inventory before adopting or mutating an existing application. Do not infer project/environment/server identity from missing response fields.

Canonical inventory is a separate operator-controlled assertion. Database records must include `databaseType: "postgresql"`. Existing application variables must include `applicationUuid`, `key`, and `valueSha256`; compute the fingerprint from the exact lane-specific value outside the repository and never store or print the value itself.

Coolify does not document API mutation endpoints for server log-drain configuration. Configure log drains in the UI and verify them separately; do not pretend the CI/CD setup configured observability.

The deployment status schema does not publish an exhaustive terminal-state enum. Treat `finished`, `success`, and `completed` as success; `failed`, `error`, and `cancelled` as failure; time out on unknown states without mutating production.
