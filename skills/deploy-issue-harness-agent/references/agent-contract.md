# OpenCode Issue agent contract

## Labels and state

```text
ai:backlog -> ai:todo -> ai:running -> ai:finished
                                  \-> ai:needs-human
```

`ai:todo` is the only pickup label. One listener and one active coding run are allowed for each repository. A parent chat may own only one unfinished Issue, while different parent chats may queue work.

## Required environment

- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`
- `GITHUB_OWNER`, `GITHUB_REPO`
- `GITHUB_BASE_BRANCH=stage`
- 32+ character `HARNESS_COMMAND_TOKEN`
- 32+ character `OPENCODE_INTERNAL_TOKEN`
- `OPENCODE_SERVER_URL`, `OPENCODE_PARENT_DIRECTORY`, `OPENCODE_MODEL_ID`
- unique `HARNESS_DATA_DIR=/opt/issue-harness/<owner>-<repository>`
- `MAX_CONCURRENT_RUNS=1`
- `HEALTH_PORT=3000`
- optional 32+ character `HARNESS_HEALTH_DETAILS_TOKEN`

OpenCode Web additionally receives `VOID_AI_BASE_URL`, `VOID_AI_API_KEY`, `VOID_AI_MODEL_ID`, login credentials, and a 32+ character session-signing secret. Harness must never receive the model API key.

## OpenCode sessions and context

- Persist `$HARNESS_DATA_DIR/opencode` as the standard OpenCode data directory.
- Persist `$HARNESS_DATA_DIR/context` as a periodically refreshed checkout of existing `stage`, mounted read-only into the parent chat.
- Persist `$HARNESS_DATA_DIR/runs` and mount the same absolute path into Harness and OpenCode Web.
- `/issue` stores `<!-- opencode-harness-parent: ses_... -->` in the GitHub Issue.
- A chat-created Issue uses that visible parent; an `ai:todo` Issue created directly in GitHub receives a standalone visible parent.
- Each Issue receives one child session and one isolated writable checkout. The parent context is never edited.
- A real `<human-attention>` question accepts the next ordinary parent reply. A technical failure is retried only through `/retry`.

## Trust boundaries

- No Sandcastle, model broker, Docker socket, or separate coding container is part of this architecture.
- The GitHub App PEM and installation tokens enter only Harness.
- The Void gateway key enters only OpenCode Web.
- The browser never receives `HARNESS_COMMAND_TOKEN` or `OPENCODE_INTERNAL_TOKEN`.
- OpenCode plugins reach privileged Harness commands through a loopback-only web proxy; the proxy adds the real command token server-side.
- Target Coolify credentials never enter Harness coding sessions.
- Harness exports a content-addressed artifact from the isolated checkout. The trusted publisher reclones current `stage`, validates the artifact, creates the commit, pushes `opencode/issue-*`, and opens a draft PR.

## Operational endpoints

- `GET /live`: process liveness.
- `GET /ready`: listener readiness.
- `GET /health/worker`: bounded worker heartbeat and activity.
- `GET /identity`: token-protected repository identity.
- `GET /diagnostics`: bounded token-protected diagnostics.
- `POST /commands/issues`: create an Issue for `/issue`.
- `POST /commands/answers`: accept a reply only for a real model question.
- `POST /commands/retries`: explicitly retry a recoverable technical failure.
- `GET /ui/tasks`: return the sanitized durable task projection for one parent session.

Online verification must use one fixed HTTPS origin, reject redirects and credentials in URLs, and cap response size.

## Completion

The verified flow is Issue → visible parent → OpenCode child session → isolated checkout → content-addressed artifact → trusted publisher → `opencode/issue-*` branch → draft PR against `stage`.
