---
description: Explicitly merge a completed Harness pull request into stage or promote stage to production
agent: build
---

Execute exactly one explicit release operation from `$ARGUMENTS`.

Use only `harness-github gh ...` and read-only shell commands. Do not edit repository files.

For `stage` or `stage #<issue>`:

1. Find the open Harness pull request whose base branch is `stage`. When an issue number is supplied, select only the PR linked to that issue; otherwise require exactly one unambiguous candidate.
2. Verify the PR head is a feature branch and the base is exactly `stage`.
3. Run `harness-github gh pr ready <number>` when the PR is draft.
4. Run `harness-github gh pr merge <number> --auto --merge`.

For `prod`:

1. Inspect open pull requests with base `main` and head `stage`.
2. Reuse that pull request when it exists; otherwise create it with `harness-github gh pr create --base main --head stage --title "Promote stage to production" --body "Automated stage to production promotion."`.
3. Run `harness-github gh pr ready <number>` when the promotion PR is draft.
4. Run `harness-github gh pr merge <number> --auto --merge`.

Never create or merge a feature branch directly into `main`. Production promotion is only `stage` to `main`. Stop with a clear error when the arguments, candidate PR, base branch, or head branch do not match these rules.
