# Production diagnostics adapter

Production diagnosis is a separate read-only identity and service. Do not reuse the coding listener or its GitHub/OpenCode/Coolify credentials.

The adapter must expose:

- `GET healthUrl` -> HTTP 200;
- `POST queryUrl` accepting `{service, environment, sinceMinutes, limit}` and returning at most `limit` redacted structured log items;
- `POST policyCheckUrl` accepting `{action}` and returning `{allowed:false}` for `deploy`, `write`, `shell`, and `sql.write`.

Repository config fields are limited to `provider`, `service`, and `environment=production`. Supply the allowed HTTPS origin, three endpoint URLs, and credential environment-variable name from operator-controlled deployment context when invoking the verifier; never trust these values from the target repository.

The adjacent `productionAgent` config must be `mode: diagnose-only`, `mutationPath: none`, and an `allowedTools` subset of `health.read`, `logs.query`, `traces.query`, `metrics.query`, and `deploy.status`. `health.read` and `logs.query` are required. The production incident form creates a diagnosis request, not authority to execute a mutation.

Prefer Coolify log drains into Loki, Axiom, New Relic, or another queryable backend. The documented Coolify API does not configure log drains; use the authenticated UI, restart the resource if required, and verify delivery. Bound queries must have time, service, environment, and result-count limits plus provider-side redaction.

No arbitrary URL proxying or redirects are allowed. All endpoints must share the operator-supplied HTTPS origin, return exact HTTP 200, and stay within the response-size limit. The adapter must allowlist the provider endpoint and query shape. A typed runbook executor, if added later, is a different identity and deployment with explicit approval, preconditions, rollback, and audit output.
