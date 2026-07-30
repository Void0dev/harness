---
name: deploy-opencode-harness
description: Use when installing one existing GitHub repository's customer-facing OpenCode Harness in the same existing Coolify environment as that repository's application.
---

# Install a Per-Project OpenCode Harness

Create exactly one new `harness` Coolify Service for exactly one repository. It contains only `issue-harness` and `opencode-web`. Never read, modify, deploy, restart, or inspect target application resources. Do not list its resources, secrets, volumes, domains, logs, or variables.

## Before asking for the six fields

Show this checklist in the operator's language, then ask for all six fields in **one message**. Do not request approval while collecting these six values.

1. Create a separate per-project GitHub App and install it on **only this one repository**. It needs Metadata - read-only; Contents, Issues, Pull requests - read and write; Administration must be disabled. Download its private PEM to an ignored local path such as `C:\harness-secrets\<project>.private-key.pem`. Never ask the user to paste PEM contents.
2. Confirm that the target repository already has `main` and `stage`. Do not create or inspect branches during installation.
3. Create an API token in the Coolify instance that hosts this project. It is separate for every Coolify server. Put it in an ignored local file such as `C:\harness-secrets\<project>-coolify.env`, with exactly `COOLIFY_TOKEN=<token>`. Never ask the operator to paste the token into chat.
4. Confirm the local Harness checkout already has `.env.local` with the shared `VOID_AI_API_KEY`. Never ask for the model, its URL, ID, key, or a path to this file.

Ask for exactly these six fields, with a one-line explanation of each:

```text
coolify_environment_url: browser URL of the exact existing Coolify environment
coolify_token_env_path: local path to this project's COOLIFY_TOKEN file
github_app_id: numeric App ID
pem_path: local path to the downloaded private-key .pem file for this project
chat_login: customer login for OpenCode Web
chat_password: customer password for OpenCode Web
```

The environment URL is the only location choice. Never ask for a repository URL, model details, DNS/domain, server UUID, destination UUID, Docker settings, or resource limits.

## Mandatory approval and boundary

After all six values arrive: Before every read or write, require a separate exact `approve <number>` for each local secret read, GitHub request, Coolify request, creation, update, restart, or verification. Number actions consecutively and use exactly:

```text
Action <number>: <plain-language description>
Target: <exact local file, GitHub repository, or Coolify Harness UUID>
Effect: <what will be read or changed>
Touches: <only Harness or its installation input>
Approval required: approve <number>
```

Any other reply means do nothing. Report only the non-secret result before presenting the next action. Never print, commit, write to disk, or return PEM data, Coolify tokens, model keys, chat passwords, or generated internal tokens. Never call DELETE.

Only these discovery reads are allowed: parse the supplied environment URL locally; `GET /api/v1/servers`; then `GET /api/v1/servers/{server_uuid}/destinations`. If exactly one usable server exists, select it automatically; otherwise ask the operator to choose by displayed name. If exactly one destination exists, select it automatically; otherwise ask the operator to choose by displayed name. Never call the environment-details endpoint, target resource list, or any target resource.

## Installation

1. Read the approved PEM and use the GitHub App to resolve its installation and `GITHUB_APP_INSTALLATION_ID`. It must expose exactly one repository. Refuse zero or multiple repositories, Admin permission, a personal token, or a different repository.
2. Read the approved per-project Coolify token file. Parse Project/environment identifiers only from the supplied browser URL.
3. Create exactly one new Coolify Service named `harness` in that environment. If that name is occupied, stop; never adopt or edit a pre-existing Service. All later writes may target only the Harness created in this installation.
4. Use `coolify/harness.production.compose.yml` as the only production template. It builds both containers from the public Harness repository's `main` branch, creates only Harness-owned volumes/secrets, mounts the GitHub PEM read-only only to `issue-harness`, keeps the worker private, and applies `cap_drop: ALL` and `no-new-privileges` to both containers. Do not use Docker socket, privileged mode, target paths, manual server files, GHCR packages, or a second Coolify GitHub App.
5. Set only the new Harness Service's own App data, repository identity, chat credentials, generated internal tokens, and PEM-derived secret. Pin `GITHUB_BASE_BRANCH=stage` and `MAX_CONCURRENT_RUNS=1`.
6. For Coolify beta.470, read `VOID_AI_API_KEY` from the local Harness `.env.local` only after approval. The template must contain exactly one `__VOID_AI_API_KEY_AT_DEPLOY__` marker in `configs.void-ai-api-key.content` and `opencode-web` must mount it at `/run/secrets/void-ai-api-key`. Always replace the marker only in memory, require one marker before and none after. Never store `VOID_AI_API_KEY` as a Service environment variable or give it to `issue-harness`.
7. The `opencode-web` environment must contain exactly `SERVICE_FQDN_OPENCODE_WEB_4096: /`. Coolify beta.470 uses this to generate its random proxied URL for port 4096. Do not use a `Generate Domain` action, configure DNS, or ask for a domain.
8. For this beta version, update Compose only with `PATCH /api/v1/services/{harness_uuid}` and JSON field `docker_compose_raw`, containing Base64 of the exact UTF-8 rendered Compose. Decode locally and compare byte-for-byte before sending. Do not send raw YAML and do not try alternate encodings.
9. Start only the new Harness with `POST /api/v1/services/{harness_uuid}/restart?latest=true`. Do not call `/deploy`; it returns `404` on this version. After an API error, read that response before changing anything.
10. After approval, read only the new `opencode-web` FQDN and return its Coolify-generated URL. Do not create a test Issue or PR merely to verify deployment.

The result is one isolated Harness in the selected environment, with two containers and one generated customer chat URL.
