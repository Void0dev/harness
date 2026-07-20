import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(relativePath, `file://${appRoot}/`), "utf8");
}

test("production image injects VITE_CONVEX_URL while building and serves immutable static output", () => {
  const dockerfile = read("Dockerfile");
  const [buildStage, runtimeStage = ""] = dockerfile.split(/\nFROM /, 2);

  assert.match(buildStage, /ARG VITE_CONVEX_URL/);
  assert.match(buildStage, /ENV VITE_CONVEX_URL=\$VITE_CONVEX_URL/);
  assert.match(buildStage, /test -n "\$VITE_CONVEX_URL"/);
  assert.match(buildStage, /RUN npm run build/);

  assert.match(runtimeStage, /^nginx:\d+\.\d+\.\d+-alpine@sha256:[a-f0-9]{64}\b/);
  assert.match(runtimeStage, /COPY --from=build .*\/dist \/usr\/share\/nginx\/html/);
  assert.match(runtimeStage, /COPY apps\/convex-demo\/nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
  assert.doesNotMatch(runtimeStage, /\bnode\b|\bnpm\b|\bvite\b/i);
});

test("Coolify supplies the public Convex URL as a Docker build argument only", () => {
  const compose = readFileSync(`${repoRoot}/coolify/docker-compose.yml`, "utf8");
  const demoService = compose.split(/\n  issue-harness:/, 1)[0];

  assert.match(demoService, /build:\s+context: \.\.\s+dockerfile: apps\/convex-demo\/Dockerfile\s+args:\s+VITE_CONVEX_URL: \$\{VITE_CONVEX_URL:\?[^}]+\}/s);
  assert.doesNotMatch(demoService, /environment:\s+VITE_CONVEX_URL:/s);
});

test("nginx serves SPA routes and a dedicated container health endpoint", () => {
  const nginx = read("nginx.conf");

  assert.match(nginx, /listen 4173;/);
  assert.match(nginx, /location = \/healthz/);
  assert.match(nginx, /return 200 '\{"status":"ok"\}';/);
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/);
});

test("public Convex functions expose an explicit disposable demo boundary and full validators", () => {
  const tasks = read("convex/tasks.ts");
  const boundary = read("DEMO_BOUNDARY.md");

  assert.match(tasks, /DEMO_BOUNDARY_ID = "public-disposable-task-board"/);
  assert.match(tasks, /MAX_TASK_TITLE_LENGTH = \d+/);
  assert.match(tasks, /MAX_DEMO_TASKS = \d+/);
  assert.match(tasks, /title\.trim\(\)/);
  assert.match(tasks, /normalized\.length > MAX_TASK_TITLE_LENGTH/);
  assert.match(tasks, /query\("tasks"\)\.take\(MAX_DEMO_TASKS\)/);
  assert.match(tasks, /existingTasks\.length >= MAX_DEMO_TASKS/);
  assert.equal((tasks.match(/args:/g) ?? []).length, 3);
  assert.equal((tasks.match(/returns:/g) ?? []).length, 3);
  assert.match(tasks, /returns: v\.array\(/);
  assert.match(tasks, /returns: v\.null\(\)/);

  assert.match(boundary, /intentionally unauthenticated/i);
  assert.match(boundary, /disposable/i);
  assert.match(boundary, /must not contain secrets|no secrets/i);
  assert.match(boundary, /separate Convex deployments/i);
  assert.match(boundary, /must never share .*sensitive|must never share .*production/i);
});
