---
name: setup-coolify-cicd
description: Prepare a Convex, NestJS/PostgreSQL, or hybrid repository for deployment and create or repair its complete Coolify delivery setup with stage mapped to staging and main mapped to gated production. Use when onboarding a project to Coolify, making a repository deployment-ready, or configuring stage/production CI/CD, branches, environments, databases, health checks, and deployment workflows.
---

# Set Up Project on Coolify

Own the complete project-onboarding path: first make the repository deployable, then bind two independent Coolify applications: `stage` to staging and `main` to production. Do not install the issue listener; `$deploy-issue-harness-agent` owns that second product.

## Modes

- `plan`: inspect and report local and external actions without mutation.
- `apply`: make repository changes and reconcile already-authorized GitHub/Coolify resources.
- `repair`: inventory drift, then update only fields owned by this skill.
- `verify`: make no changes and re-prove local readiness and external bindings.

Default a clear setup request to `apply`. Never perform the first production deployment, rotate secrets, replace a database, or weaken protection without explicit authority.

## 1. Prepare the repository

1. Read repository instructions, Git status, manifests, lockfiles, Docker/deployment files, workflows, health endpoints, migrations, and existing `.harness/` files.
2. Run `python3 <skill-dir>/scripts/doctor.py <repo-root> --json`, then read `references/readiness-contract.md`. Resolve the service root and select exactly one supported profile: `convex`, `nest-postgres`, or `hybrid`.
3. Reuse existing commands and dependencies. Define install, test, lint/typecheck, build, and smoke commands. Add Convex `backendCheck`/deploy commands or NestJS/PostgreSQL migration check/stage/production commands as required.
4. Add or repair:
   - `.harness/config.json` using `assets/config.example.json` as its shape;
   - a deterministic Docker/build contract and health endpoint;
   - sanitized `.env.example` variable names without credential values;
   - `.github/workflows/ci.yml`, adapting `assets/ci.yml` when compatible CI is absent;
   - explicit stdout/stderr logging and environment completeness.
5. Run project checks and `python3 <skill-dir>/scripts/doctor.py <repo-root> --json --run-commands`. Do not continue to external setup while local readiness errors remain.

## 2. Bind GitHub and Coolify

Read `references/coolify-api.md`. Verify the GitHub repository and visibility; Coolify URL, project/server/GitHub App UUIDs; service root/build pack; ports/health path; and distinct stage/production domains and stateful backends. Never guess an external value.

1. Inspect branches, rules, GitHub environments/secrets, Coolify environments/applications/databases, and domains before mutation.
2. Create `stage` from `main` only when absent. Never reset or force-push either branch.
3. Create or bind separate Coolify `stage` and `production` environments, applications, domains, credentials, and data backends. For NestJS/PostgreSQL, use two PostgreSQL resources and store their actual UUIDs. For Convex, use two permanent deployments and environment-scoped deploy keys.
4. Install `.github/workflows/coolify-deploy.yml` from `assets/coolify-deploy.yml`. Merge the matching Convex and/or Nest migration jobs, substitute the exact commands from `.harness/config.json`, and make deploy depend on every required gate.
5. Record exact reviewed gate runner labels in `deployment.gateRunners`. Use `ubuntu-latest` unless a private database requires a dedicated self-hosted runner. Do not accept runner expressions, extra jobs/actions/triggers, permission escalation, `continue-on-error`, `always()`, or unresolved `__HARNESS_*` placeholders.
6. Generate a non-mutating plan:

   ```bash
   python3 <skill-dir>/scripts/coolify_reconcile.py <repo-root> plan
   ```

7. With authorized credentials, reconcile resources:

   ```bash
   COOLIFY_URL=... COOLIFY_TOKEN=... \
     python3 <skill-dir>/scripts/coolify_reconcile.py <repo-root> apply \
     --allow-external-writes --inventory-json <fresh-inventory.json>
   ```

   Use fresh operator-controlled inventory for every existing application and all NestJS/PostgreSQL setups. Require `source`, timezone-aware `observedAt` no older than ten minutes, canonical application/database identity, and SHA-256 fingerprints for existing environment values. Never print raw values or fingerprints.
8. Configure GitHub environments `stage` and `production`. Store lane-specific `COOLIFY_TOKEN`, resource UUID, health URL, and only the stack secret required by that lane. Require review for production when supported; do not weaken existing rules.
9. Disable Coolify source auto-deploy when GitHub Actions owns deployment. Deploy and smoke-test staging. Dry-verify production; leave its first deployment gated.
10. Verify the workflow and external state:

    ```bash
    python3 <skill-dir>/scripts/validate_workflow.py <repo-root>
    COOLIFY_URL=... COOLIFY_TOKEN=... \
      python3 <skill-dir>/scripts/coolify_reconcile.py <repo-root> verify \
      --inventory-json <fresh-inventory.json>
    ```

## Safety and claims

- Setup token: least-privilege `read` + `write`; deployment token: `deploy` + `read`. Never use `root` or `read:sensitive`.
- PATCH only managed drift. Update environment variables one key at a time; never bulk replace or silently rotate them.
- Never overwrite an occupied domain, delete/recreate persistent state, connect a coding agent to production credentials, or run a production migration outside the gated job.
- Claim `repo-ready` only after fresh doctor and project checks pass.
- Claim `cicd-bound` only after fresh GitHub/Coolify inventory proves distinct applications, domains, environments, and backends.
- Claim `stage-healthy` only after a fresh immutable deployment and HTTP smoke pass.
- Claim `production-configured`, not `production-live`, until an authorized production deployment succeeds.
