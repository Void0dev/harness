# Harness image release

Deploy only canonical images addressed by digest from public GHCR packages:

- `ghcr.io/void0dev/issue-harness@sha256:<64-hex-digest>`
- `ghcr.io/void0dev/opencode-web@sha256:<64-hex-digest>`

Resolve both digests from one successful `Publish harness images` workflow run on `refs/heads/main`. Both images must bind the same full source commit. Never deploy a floating tag, a digest from a fork, or images from different workflow runs.

Both canonical packages must be public so a repository-scoped target GitHub App never needs access to `Void0dev/harness` packages and the deployment host never stores a personal package token.

Verify each subject directly with GitHub CLI before deployment:

```text
gh attestation verify oci://ghcr.io/void0dev/<image>@sha256:<digest> \
  --repo Void0dev/harness \
  --signer-workflow Void0dev/harness/.github/workflows/publish-images.yml \
  --source-digest <full-source-commit> \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

After rollout, inspect the actual image references used by both running services and require exact equality with the verified digests. Configuration values alone are not rollout evidence. If no verified canonical publication exists, stop instead of building or publishing from the deployment host.

The repository Dockerfiles pin their base image by digest. When changing that digest, inspect the upstream OCI index, run the full repository verification suite, and publish through the canonical workflow.
