---
name: deploy-opencode-harness
description: Use when deploying one existing GitHub repository's customer-facing OpenCode Harness into the same existing Coolify production environment as that repository's application.
---

# Install a Per-Project OpenCode Harness

Deploy exactly one Harness for exactly one repository. Add a separate Harness Compose resource to the selected existing Coolify production environment; do not modify the target application's resources, source, deployment, storage, or secrets.

`references/developer-profile.md` contains fixed developer rules. Do not ask for the model, model key, Coolify token value, resource limits, DNS details, internal tokens, or a chat domain.

## Ask the operator for exactly these six fields

Ask in the user's language and explain every field before requesting it:

```text
coolify_environment_url: browser URL of the existing Coolify production environment
coolify_token_env_path: local path to the file containing COOLIFY_TOKEN
github_app_id: numeric App ID shown in the GitHub App settings
pem_path: local path to the downloaded private-key .pem file
chat_login: login the customer will use to enter OpenCode Web
chat_password: password the customer will use to enter OpenCode Web
```

- `coolify_environment_url` identifies the exact Coolify folder in which to create the Harness resource. Parse its Project and environment UUIDs. It is the only user-facing choice of location; never ask for a server UUID or destination UUID.
- `coolify_token_env_path` is the local path to the operator's private file containing `COOLIFY_TOKEN=<token>`. Read only that variable after approval; never ask the operator to paste the token into chat, print it, or commit the file.
- `github_app_id` and `pem_path` authenticate the per-project GitHub App. Never ask the user to paste PEM contents. Read only the local file at `pem_path`.
- `chat_login` and `chat_password` are operator-selected credentials; do not generate or replace them.

Do not request approval while collecting these six values. After they are all present, use `GITHUB_APP_ID` and the PEM to resolve `GITHUB_APP_INSTALLATION_ID` and list the App installation repositories. It must expose exactly one repository; use that repository as the Harness target. If it exposes zero or more than one repository, stop without an action. Require Metadata read, Contents read/write, Issues read/write, and Pull requests read/write. Refuse Admin permission, a personal access token, an App installation that sees another repository, or a missing `stage` or `main` branch.

Do not ask the operator for a domain and do not configure DNS. After creating `opencode-web`, use Coolify's `Generate Domain` action and retain its Coolify-generated HTTPS URL.

## Mandatory approval gate and Coolify boundary

After all six values are collected: Before every read or write, show one numbered action in this exact shape:

```text
Action <number>: <plain-language description>
Target: <exact local file, GitHub repository, or Coolify Harness UUID>
Effect: <what will be read or changed>
Touches: <only Harness or its installation input>
Approval required: approve <number>
```

Wait for the exact response `approve <number>`. Any other response means perform no action. After the approved action completes, report only its non-secret result and present the next action. Require approval before reading `pem_path`, reading `coolify_token_env_path`, making a GitHub request, making any Coolify request, creating a resource, setting a secret, generating a domain, deploying, or verifying.

Never call DELETE. Never read, modify, deploy, restart, or inspect target application resources: this includes every existing application, database, service, volume, environment variable, deployment, log, and domain. Do not list environment resources. Do not PATCH an existing resource. Do not create a database, service, application, domain outside `opencode-web`, or network outside the Harness Compose resource.

The only permitted infrastructure reads are the same safe selection steps used by the Coolify UI: `GET /api/v1/servers`, then `GET /api/v1/servers/{server_uuid}/destinations` for the selected server. They read server and Docker-destination metadata only, never target resources. If exactly one usable server exists, select it automatically; otherwise ask the operator to choose by displayed server name. If exactly one destination exists, select it automatically; otherwise ask the operator to choose by displayed destination name. Never call the environment-details endpoint, project resource lists, application, database, service, log, volume, or domain endpoints to discover these values.

The only permitted Coolify write sequence is: create one Harness Compose resource in the explicitly supplied environment; then use only the Harness UUID created in this installation to set its own variables, attach its own storage and PEM mount, generate the `opencode-web` domain, and deploy it. If creation reports a name collision or any required identifier is unavailable, stop without changing anything. Never adopt, update, or delete a pre-existing Harness resource.

## Deploy

1. Parse the explicitly supplied `coolify_environment_url`; derive its API origin and exact Project/environment UUIDs without persisting the URL. Use the approved server/destination selection reads above. Never infer them from or inspect the target application.
2. Create only one `harness` Service through `POST /api/v1/services`, using the selected Project, environment, and server. Omit `destination_uuid` when the selected server has exactly one destination. The Service contains `issue-harness` and `opencode-web`; keep `issue-harness` private and use Coolify's `Generate Domain` action only for `opencode-web`.
3. Create a unique persistent data root for this repository. Mount OpenCode state, read-only `stage` context, and the run workspace exactly as required by `$deploy-issue-harness-agent`; do not mount target application paths or a Docker socket.
4. Create or reference the Coolify secret file mount `/run/secrets/github-app.pem` from `pem_path`. Mount it read-only only into `issue-harness`. If secure file-mount creation is unavailable, pause for the operator to upload that local file in Coolify; never use a repository file or environment-variable PEM.
5. Store the supplied `chat_login` and `chat_password` as the OpenCode Web credentials. Generate only internal 32+ character command, session, and diagnostics secrets; never display them.
6. Pin `GITHUB_BASE_BRANCH=stage`, `MAX_CONCURRENT_RUNS=1`, no public worker port, `no-new-privileges`, and the fixed deployment defaults. Do not add target production credentials to Harness.
7. Use `$deploy-issue-harness-agent` for the runtime contract and deployment verification. Do not create `stage` or `main`, or deploy the target application.

## Acceptance check

Verify that normal chat reads refreshed `stage` context without editing it; `/issue` creates the parent-marked Issue; the worker creates a child session in an isolated checkout; and the trusted publisher opens `opencode/issue-*` as a draft PR into `stage`. Prove the full Issue → child session → branch → PR flow. Return the Coolify-generated HTTPS URL, Issue URL, and PR URL. Never return credentials, PEM data, model keys, Coolify tokens, or generated secrets.

Sandcastle and model-broker are not part of this architecture.
