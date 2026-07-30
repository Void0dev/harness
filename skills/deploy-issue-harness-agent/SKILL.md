---
name: deploy-issue-harness-agent
description: Use when an existing repository needs authenticated OpenCode Web, GitHub Issue automation, parent/child sessions, persistent history, health checks, and trusted PR publishing deployed or repaired.
---

# Deploy the OpenCode Issue Worker

Deploy one Harness addon for one existing repository. It must not create or deploy the target application, `stage`, or `main`.

## Required inputs

- target `owner/repository` with existing `stage` and `main`;
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and the GitHub App PEM installed on that repository;
- Harness host or existing Coolify destination;
- Void gateway URL, API key, and exact model ID;
- OpenCode Web domain and username/password.

## Runtime contract

- OpenCode Web is the only service that receives `VOID_AI_API_KEY`.
- The public proxy uses a separate 32+ character `OPENCODE_SESSION_SECRET`; browser sessions use signed HttpOnly cookies lasting at least 24 hours.
- Harness calls the authenticated OpenCode Server API; there is no Sandcastle, coding container, model broker, or Docker socket.
- `/issue` stores the parent session ID in the GitHub Issue.
- Harness creates one temporary writable checkout and one OpenCode child session per Issue.
- The parent receives compact progress and final PR links; detailed work remains in the child session.
- Mount `$HARNESS_DATA_DIR/runs` read/write into OpenCode Web at the same absolute path used by Harness.
- Mount `$HARNESS_DATA_DIR/context` read-only for the parent chat.
- Keep `MAX_CONCURRENT_RUNS=1`.
- Accept only immutable, attested images from the trusted publisher before rollout.

## Workflow

1. Verify the repository and required branches already exist.
2. Install or repair labels and repository workflow assets without overwriting compatible project files.
3. Deploy Harness and OpenCode Web using `assets/coolify-agent-compose.yml`.
4. Mount the GitHub App PEM only into Harness, read-only.
5. Configure OpenCode authentication, provider, model, shared session storage, read-only context, and writable runs storage.
6. Verify `/live`, `/ready`, repository identity, and one active listener.
7. With explicit authorization, create one smoke Issue and prove Issue → child session → branch → PR into `stage`.

Never print or return secret values.
