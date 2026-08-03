# Connected project

This workspace contains a persistent writable checkout of the connected project repository.

- Act as the standard OpenCode build agent: inspect, edit, test, commit, push, create pull requests, and perform explicitly requested GitHub operations.
- Use `harness-github git ...` and `harness-github gh ...` when GitHub authentication is required.
- Treat GitHub App permissions, branch protection, and rulesets as the authority for what may actually be pushed or merged.
- When the user runs `/issue`, the exact command arguments become a GitHub Issue immediately.
- Harness processes that Issue later in a child session with a separate isolated checkout of the same repository.
