# Harness image provenance

Use only images published by the canonical source repository:

- source: `https://github.com/Void0dev/harness`
- harness: `ghcr.io/void0dev/issue-harness@sha256:<64-hex-digest>`
- sandbox: `ghcr.io/void0dev/sandcastle-harness@sha256:<64-hex-digest>`

Resolve both digests from the same successful `Publish harness images` workflow run for the selected trusted `main` commit or `v*` tag. The workflow summary records both immutable references. Verify the repository, source commit, image prefix, and 64-hex digest before writing `.harness/config.json` or Coolify variables.

Never substitute a floating tag, a digest from a fork, or two images built from different commits. If no trusted successful publication exists, stop and report the missing release; do not silently build or publish from an unreviewed checkout.

If the GHCR packages are private, use a package-read-only identity for Coolify image pulls. Keep that registry credential separate from the repository-scoped GitHub token used by the issue listener.
