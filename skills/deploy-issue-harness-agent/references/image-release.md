# Harness image provenance

Use only images published by the canonical source repository:

- source: `https://github.com/Void0dev/harness`
- harness: `ghcr.io/void0dev/issue-harness@sha256:<64-hex-digest>`
- OpenCode Web: `ghcr.io/void0dev/opencode-web@sha256:<64-hex-digest>`

Resolve both digests from the same successful `Publish harness images` workflow run for `refs/heads/main`. Pushes of tags do not trigger image builds. A manual `workflow_dispatch` from any non-main ref fails in its first step, before checkout, registry login, build, or publication. The workflow emits OCI source/revision labels, BuildKit provenance, and GitHub artifact attestations, then records each subject, canonical source, full source commit, and publication run ID.

An optional version promotion may only create a registry alias for an existing main-built digest after its GitHub attestation has been verified. It must not rebuild from the version tag, change the subject digest, or replace the recorded main source ref/commit/run. Treat the digest—not the alias—as the deployable identity.

## Offline cryptographic verification

On an online evidence host, download the exact OCI index manifest bytes for each digest, each GitHub attestation bundle, and fresh trust roots (`gh attestation trusted-root > trusted_root.jsonl`). Transfer those files to the verifier host. Do not trust an inventory boolean or a copied JSON predicate.

`verify_agent.py` hashes each local OCI manifest and requires it to equal the configured subject digest, then executes the official CLI contract without a shell:

```text
gh attestation verify <local-oci-manifest> \
  --repo Void0dev/harness \
  --bundle <local-bundle.jsonl> \
  --custom-trusted-root <trusted_root.jsonl> \
  --signer-workflow Void0dev/harness/.github/workflows/publish-images.yml \
  --source-digest <full-source-commit> \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners \
  --predicate-type https://slsa.dev/provenance/v1 \
  --format json
```

The verifier accepts only `refs/heads/main` as the attested source ref. It additionally parses the cryptographically verified statement and certificate, requiring the canonical subject name/digest, repository, workflow URI/ref, source commit, GitHub-hosted runner, and `runInvocationURI` for the configured publication run. Both images must bind the same commit/ref/run. `--bundle` plus `--custom-trusted-root` and a local manifest make this provenance step offline; operational health probes are separate. Refresh trusted roots whenever importing new signed material. Stale roots cannot report later revocation or rotated key material, so their acquisition remains operator-controlled evidence.

After rollout, inspect the Issue Harness image and OpenCode Web image. Both rollout refs must exactly equal the attested subjects and report `running`; queue/config values alone are not rollout evidence. Never substitute a floating tag, a digest from a fork, or two images built from different commits/runs. If no trusted successful publication exists, stop and report the missing release; do not silently build or publish from an unreviewed checkout.

If the GHCR packages are private, use a package-read-only identity for Coolify image pulls. Keep that registry credential separate from the GitHub App credentials used by the issue listener.

## Published base-image material

Every published stage is pinned to a multi-architecture OCI index digest. Registry evidence was refreshed on 2026-07-17:

| Dockerfile stage | Immutable base |
| --- | --- |
| issue harness and OpenCode Web | `node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37` |
| Convex demo build | `node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2` |
| Convex demo runtime | `nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14` |

For an update, inspect the registry index (`docker buildx imagetools inspect <tag> --format '{{json .Manifest}}'`), require an OCI image index with the intended architectures, record the returned index digest, update only the matching `FROM`, rebuild/test/lint/typecheck, and publish the Harness and OpenCode Web images through the canonical workflow. The final GitHub attestation links the output subject to this repository workflow and source commit; the table records the reviewed upstream material selected by that source.
