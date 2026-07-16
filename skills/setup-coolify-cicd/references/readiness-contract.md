# Repository readiness contract

## Common contract

- Branch mapping: `stage` is persistent staging; `main` is production; agent PR base is `stage`.
- A lockfile exists and CI uses the matching frozen install command.
- Build, test, typecheck/lint, startup, health, and smoke commands are explicit.
- The service emits logs to stdout/stderr and includes environment, service, source commit, and correlation ID where available.
- `/health` proves process liveness. A separate readiness route may verify required dependencies without exposing secrets.
- Docker images run a production command, define a healthcheck, and do not bake secrets.
- `.env.example` documents required variable names and safe examples only.
- `.harness/config.json` is declarative and contains no credential values.

## Convex adapter

- Use distinct permanent Convex deployments for stage and production.
- Supply `VITE_*` values at frontend build time, not only container runtime.
- Keep deploy keys environment-scoped. Do not expose a production deploy key to the coding agent.
- Verify frontend build, Convex schema/functions, and stage deployment separately.
- Declare `commands.backendCheck`, `commands.deployStage`, and `commands.deployProduction`. The readiness doctor runs only the non-mutating backend check; the environment-scoped delivery workflow owns deployments.

## NestJS/PostgreSQL adapter

- Use distinct stage and production PostgreSQL resources/databases and credentials.
- Store verified Coolify PostgreSQL UUIDs as each environment's `dataBackendRef`; descriptive strings are not evidence of separation.
- Make migrations an explicit gated job; do not hide production migrations in application startup.
- Health checks distinguish process liveness from database readiness.
- Document rollback/forward-fix behavior for each migration.
- Declare `commands.migrateCheck`, `commands.migrateStage`, and `commands.migrateProduction`. The readiness doctor runs only `migrateCheck`; migrations execute as separately gated environment jobs, never during app startup.

## Minimal `.harness/config.json`

Use `assets/config.example.json` as the shape. Replace detected local fields. Keep unknown external bindings as `null`.
