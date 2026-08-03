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

Both services receive the same repository-scoped GitHub App ID, Installation ID, owner, repository, base branch, and read-only PEM mount. The public Harness additionally receives login credentials and a 32+ character session-signing secret. The private `opencode-runtime` receives `VOID_AI_BASE_URL`, `VOID_AI_API_KEY`, `VOID_AI_MODEL_ID`, and the OpenCode SQLite volume. Harness must never receive the model API key; the runtime must never receive web credentials or the session-signing secret.

## OpenCode sessions and context

- Persist the private runtime's `/home/opencode/.local/share` as the standard OpenCode data directory containing SQLite.
- Persist `$HARNESS_DATA_DIR/context` as a periodically refreshed checkout of existing `stage`, mounted read-only into the parent chat.
- Persist `$HARNESS_DATA_DIR/runs` and mount the same absolute path into Harness and `opencode-runtime`.
- `/issue` stores `<!-- opencode-harness-parent: ses_... -->` in the GitHub Issue.
- A chat-created Issue uses that visible parent; an `ai:todo` Issue created directly in GitHub receives a standalone visible parent.
- Each Issue receives one child session and one isolated writable checkout. The parent context is never edited.
- A real `<human-attention>` question accepts the next ordinary parent reply. A technical failure is retried only through `/retry`.

## Trust boundaries

- No Sandcastle, model broker, Docker socket, or separate coding container is part of this architecture.
- The public `harness` is the authenticated web gateway and Issue worker.
- The private `opencode-runtime` has no public route and accepts only the internal bearer supplied by Harness.
- The GitHub App PEM and repository coordinates are available to both services so coding and release agents can authenticate GitHub CLI operations.
- The Void gateway key enters only `opencode-runtime`.
- The browser never receives `HARNESS_COMMAND_TOKEN` or `OPENCODE_INTERNAL_TOKEN`.
- OpenCode plugins reach privileged Harness commands through a loopback-only web proxy; the proxy adds the real command token server-side.
- Target Coolify credentials never enter Harness coding sessions.
- The coding agent works in the isolated checkout, creates its own commit, pushes `opencode/issue-*` with `harness-github git`, and creates or reuses a draft PR into `stage` with `harness-github gh`.
- Normal Issue processing always stops at that draft PR. Authenticated `/merge stage`, `/merge stage #<issue>`, or `/merge prod` starts a separate ordinary release agent, which reads current GitHub state and performs the requested operation with `gh`. Production is always a `stage -> main` pull request.

## Operational endpoints

- `GET /live`: process liveness.
- `GET /ready`: listener readiness.
- `GET /health/worker`: bounded worker heartbeat and activity.
- `GET /identity`: token-protected repository identity.
- `GET /diagnostics`: bounded token-protected diagnostics.
- `POST /commands/issues`: create an Issue for `/issue`.
- `POST /commands/answers`: accept a reply only for a real model question.
- `POST /commands/retries`: explicitly retry a recoverable technical failure.
- `/merge` is handled as an ordinary release-agent task. Harness owns no merge endpoint, merge service, or operation ledger; the release agent uses current GitHub state and standard `gh` commands.
- `GET /ui/tasks`: return the sanitized durable task projection for one parent session.

Online verification must use one fixed HTTPS origin, reject redirects and credentials in URLs, and cap response size.

## Completion

The verified default flow is Issue → visible parent → OpenCode child session → isolated checkout → coding agent commit → push of `opencode/issue-*` → draft PR against `stage`, with no automatic merge. The explicit release flows run in a separate release agent through `gh`: feature PR → `stage` and `stage` → `main`.
