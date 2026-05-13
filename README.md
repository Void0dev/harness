# Harness

This repository contains two deployable pieces:

- `apps/convex-demo` - a small Convex + Vite demo app.
- `services/issue-harness` - a GitHub Issues daemon that turns labeled tickets into Sandcastle/Codex runs and pull requests.

## Issue Tracker Contract

GitHub Issues are the tracker. Status is represented by labels:

- `ai:backlog` - ignored by the agent.
- `ai:todo` - agent may pick it up.
- `ai:running` - agent claimed it and is working.
- `ai:finished` - pull request was created.
- `ai:needs-human` - agent is blocked or has a question.

The harness writes progress logs into issue comments. When a human answers and removes `ai:needs-human`, the daemon can continue the issue from its persisted run state.

## Local Setup

```bash
npm install
npm run build
cp .env.example .env
```

Run the demo app:

```bash
npm run dev:demo
```

Run the issue harness:

```bash
npm run dev:harness
```

## Coolify

Use `coolify/docker-compose.yml`. The harness service needs:

- `GITHUB_TOKEN` with issue, pull request, contents, and metadata permissions.
- `OPENAI_API_KEY` for Codex.
- Docker socket access for Sandcastle's Docker sandbox provider.
- A persistent volume mounted at `/data` to keep `.sandcastle`, `.codex`, logs, and issue run state.

For subscription-based Codex usage, set `CODEX_AUTH_MODE=subscription` and run `codex login --device-auth` once against the persistent Codex home mounted at `.harness/codex` locally or `/data/codex` in Coolify. For API billing usage, set `CODEX_AUTH_MODE=api-key` and provide `OPENAI_API_KEY`.

The Convex frontend can be deployed as a static/Vite service. The Convex backend itself still needs `npx convex deploy` against a Convex project.
