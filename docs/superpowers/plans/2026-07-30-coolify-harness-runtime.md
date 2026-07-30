# Coolify Harness Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Issue Harness without root privileges and provide a production-only Coolify Compose template for the two Harness containers.

**Architecture:** The worker image creates the persistent mount targets owned by UID 10001 during image build. Docker initializes fresh named volumes from those targets, so the runtime process can create its own state without `chown`, `gosu`, Linux capabilities, or root. The new Compose template pins two externally supplied immutable image digests and uses four service-scoped named volumes: worker state, stage context, worker runs, and OpenCode state.

**Tech Stack:** Docker Compose, Docker named volumes, Bash, Node.js test runner, Python contract tests.

---

### Task 1: Lock the runtime and Compose safety contract

**Files:**
- Modify: `tests/test_product_contract.py`
- Create: `coolify/harness.production.compose.yml`

- [ ] **Step 1: Write a failing contract test**

```python
worker = (ROOT / "services/issue-harness/Dockerfile").read_text()
start = (ROOT / "services/issue-harness/start.sh").read_text()
compose = (ROOT / "coolify/harness.production.compose.yml").read_text()
self.assertIn("USER agent", worker)
self.assertNotIn("gosu", worker)
self.assertNotIn("gosu", start)
self.assertNotIn("chown", start)
self.assertNotIn("build:", compose)
self.assertIn("cap_drop:\n      - ALL", compose)
self.assertNotIn("docker.sock", compose)
```

- [ ] **Step 2: Run the test and verify it fails on the existing root-based image**

Run: `python -m unittest tests.test_product_contract.ProductContractTest.test_coolify_harness_runtime_is_non_root_and_isolated`

Expected: failure because the Dockerfile installs `gosu` and does not set `USER agent`.

### Task 2: Make the worker image run as `agent`

**Files:**
- Modify: `services/issue-harness/Dockerfile`
- Modify: `services/issue-harness/start.sh`
- Modify: `services/issue-harness/runtime_permissions.sh`

- [ ] **Step 1: Create all future named-volume targets during build as UID 10001**

```dockerfile
RUN useradd -m -u 10001 agent \
  && install -d -o agent -g agent -m 0700 \
    /opt/issue-harness/data \
    /opt/issue-harness/data/context \
    /opt/issue-harness/data/runs \
    /home/agent
USER agent
```

- [ ] **Step 2: Keep startup validation and locking, but remove ownership escalation**

```bash
harden_harness_runtime "$data_dir"
exec npm run start -w services/issue-harness
```

`harden_harness_runtime` must create and chmod private Harness directories but must not call `chown`.

- [ ] **Step 3: Run the focused contract and TypeScript checks**

Run: `python -m unittest tests.test_product_contract.ProductContractTest.test_coolify_harness_runtime_is_non_root_and_isolated; npm.cmd run typecheck`

Expected: both commands exit 0.

### Task 3: Add the production-only Compose template

**Files:**
- Create: `coolify/harness.production.compose.yml`
- Modify: `tests/test_product_contract.py`

- [ ] **Step 1: Define two digest-pinned images with no build section**

```yaml
services:
  issue-harness:
    image: ${HARNESS_IMAGE:?set an immutable ghcr.io/void0dev/issue-harness digest}
  opencode-web:
    image: ${OPENCODE_WEB_IMAGE:?set an immutable ghcr.io/void0dev/opencode-web digest}
```

- [ ] **Step 2: Attach only Harness-owned named volumes and no host mounts**

```yaml
volumes:
  harness-state:
  harness-context:
  harness-runs:
  opencode-state:
```

Mount `harness-context` read/write only in `issue-harness` and read-only at the same absolute path in `opencode-web`; mount `harness-runs` read/write at the same absolute path in both services. Use Coolify's own secret-file mount to attach `/run/secrets/github-app.pem` only after the Service is created; no PEM content or host path belongs in this file.

- [ ] **Step 3: Apply the same non-root hardening to both services**

```yaml
user: "10001:10001"
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

`issue-harness` has no `ports`; `opencode-web` only declares `expose: ["4096"]`, so Coolify can generate its URL without binding a host port.

- [ ] **Step 4: Run Compose parsing without interpolating secrets and run the focused contract**

Run: `docker compose -f coolify/harness.production.compose.yml config --no-interpolate; python -m unittest tests.test_product_contract.ProductContractTest.test_coolify_harness_runtime_is_non_root_and_isolated`

Expected: Compose accepts YAML structure and the contract passes.

### Task 4: Verify an actual local two-container startup

**Files:**
- No source changes expected.

- [ ] **Step 1: Rebuild and start only local Harness containers**

Run: `docker compose --env-file .env.local -f docker-compose.local.yml up --build -d`

Expected: exactly `issue-harness` and `opencode-web` start.

- [ ] **Step 2: Verify login endpoint without printing credentials or logs containing secrets**

Run: `curl.exe -I --max-time 15 http://localhost:4096/login`

Expected: HTTP 200 and no `xdg-open` invocation in the `opencode-web` logs.
