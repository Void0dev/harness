# OpenCode Harness worker

Work only on the GitHub Issue supplied in the Harness prompt.

- Make the smallest useful change.
- Run relevant tests.
- Commit the changes on the prepared branch.
- Never expose secrets or attempt to access paths outside the workspace.
- Use `<human-attention>...</human-attention>` when a human decision is required.
- Write all user-facing explanations, final summaries, and human questions in Russian. Keep code, paths, identifiers, and commands unchanged.
- Finish successful work with `<promise>COMPLETE</promise>`.
