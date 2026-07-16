import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_inventory_metadata():
    return {
        "source": "coolify-api",
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def run_script(relative, *args, env=None):
    return subprocess.run(
        ["python3", str(ROOT / relative), *map(str, args)],
        text=True,
        capture_output=True,
        env=env,
    )


def config():
    return {
        "schemaVersion": 1,
        "project": {"slug": "service", "github": "acme/service", "stack": "nest-postgres", "serviceRoot": "."},
        "branches": {"stage": "stage", "production": "main", "agentPrBase": "stage"},
        "commands": {
            "install": "echo install", "test": "true", "typecheck": "true", "build": "true", "smoke": "true",
            "migrateCheck": "true", "migrateStage": "echo migrate-stage", "migrateProduction": "echo migrate-production",
            "backendCheck": "true", "deployStage": "echo convex-stage", "deployProduction": "echo convex-production",
        },
        "runtime": {"port": 3000, "healthPath": "/health"},
        "deployment": {"sourceVisibility": "private", "buildPack": "dockerfile", "dockerfile": "Dockerfile", "gateRunners": {"stage": "ubuntu-latest", "production": "ubuntu-latest"}, "requiredEnvironmentVariables": ["DATABASE_URL"], "distinctEnvironmentVariables": ["DATABASE_URL"]},
        "coolify": {
            "projectUuid": "project-1", "serverUuid": "server-1", "githubAppUuid": "github-1",
            "stage": {"environment": "stage", "applicationUuid": "app-stage", "domain": "https://stage.example.test", "dataBackendProvider": "coolify-postgresql", "dataBackendRef": "postgres-stage", "environmentVariableRefs": {"DATABASE_URL": "STAGE_DATABASE_URL"}},
            "production": {"environment": "production", "applicationUuid": "app-prod", "domain": "https://example.test", "dataBackendProvider": "coolify-postgresql", "dataBackendRef": "postgres-production", "environmentVariableRefs": {"DATABASE_URL": "PRODUCTION_DATABASE_URL"}},
        },
        "issueAgent": {
            "applicationUuid": "app-agent", "baseBranch": "stage",
            "harnessImage": "ghcr.io/acme/harness@sha256:" + "a" * 64,
            "sandboxImage": "ghcr.io/acme/sandbox@sha256:" + "b" * 64,
            "serverUuid": "automation-server", "dataDir": "/opt/issue-harness/acme-service",
            "dedicatedAutomationHost": True, "maxConcurrentRuns": 1, "replicas": 1,
        },
    }


def delivery_workflow(stack):
    workflow = (ROOT / "skills/setup-coolify-cicd/assets/coolify-deploy.yml").read_text()
    fragments = []
    stage_gates = []
    production_gates = []
    commands = config()["commands"]
    if stack in ("nest-postgres", "hybrid"):
        fragment = (ROOT / "skills/setup-coolify-cicd/assets/nest-migration-jobs.yml").read_text()
        fragment = fragment.replace("npm ci", commands["install"])
        fragment = fragment.replace("__HARNESS_MIGRATE_STAGE__", commands["migrateStage"])
        fragment = fragment.replace("__HARNESS_MIGRATE_PRODUCTION__", commands["migrateProduction"])
        fragments.append(fragment)
        stage_gates.append("migration-stage")
        production_gates.append("migration-production")
    if stack in ("convex", "hybrid"):
        fragment = (ROOT / "skills/setup-coolify-cicd/assets/convex-delivery-jobs.yml").read_text()
        fragment = fragment.replace("npm ci", commands["install"])
        fragment = fragment.replace("__HARNESS_CONVEX_DEPLOY_STAGE__", commands["deployStage"])
        fragment = fragment.replace("__HARNESS_CONVEX_DEPLOY_PRODUCTION__", commands["deployProduction"])
        fragments.append(fragment)
        stage_gates.append("backend-stage")
        production_gates.append("backend-production")
    stage_needs = stage_gates[0] if len(stage_gates) == 1 else f"[{', '.join(stage_gates)}]"
    production_needs = production_gates[0] if len(production_gates) == 1 else f"[{', '.join(production_gates)}]"
    workflow = workflow.replace("needs: verify", f"needs: {stage_needs}", 1)
    workflow = workflow.replace("needs: verify", f"needs: {production_needs}", 1)
    indented = "\n".join(
        "  " + line if line else line
        for fragment in fragments
        for line in fragment.splitlines()
    )
    return workflow.replace("jobs:\n", f"jobs:\n{indented}\n")


class SkillScriptsTest(unittest.TestCase):
    def test_repository_exposes_exactly_two_installable_skills(self):
        skill_names = sorted(
            path.name for path in (ROOT / "skills").iterdir()
            if path.is_dir() and (path / "SKILL.md").is_file()
        )
        self.assertEqual(skill_names, ["deploy-issue-harness-agent", "setup-coolify-cicd"])

        project_skill = ROOT / "skills" / "setup-coolify-cicd"
        for relative in (
            "scripts/doctor.py",
            "scripts/coolify_reconcile.py",
            "scripts/validate_workflow.py",
            "assets/config.example.json",
            "assets/ci.yml",
            "assets/coolify-deploy.yml",
        ):
            self.assertTrue((project_skill / relative).is_file(), relative)

        harness_skill = ROOT / "skills" / "deploy-issue-harness-agent"
        for relative in (
            "scripts/verify_agent.py",
            "scripts/github_labels.py",
            "assets/coolify-agent-compose.yml",
            "assets/agent-task.yml",
            "references/image-release.md",
        ):
            self.assertTrue((harness_skill / relative).is_file(), relative)
        release_contract = (harness_skill / "references" / "image-release.md").read_text()
        self.assertIn("https://github.com/Void0dev/harness", release_contract)
        self.assertIn("ghcr.io/void0dev/issue-harness@sha256:", release_contract)
        self.assertIn("ghcr.io/void0dev/sandcastle-harness@sha256:", release_contract)

    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(temporary.name)
        (root / ".harness").mkdir()
        (root / ".harness" / "config.json").write_text(json.dumps(config()))
        (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1","pg":"1"}}')
        (root / "package-lock.json").write_text("{}")
        (root / "Dockerfile").write_text("FROM scratch\n")
        (root / ".env.example").write_text("DATABASE_URL=\n")
        (root / ".sandcastle").mkdir()
        (root / ".sandcastle" / "prompt.md").write_text("prompt\n")
        (root / ".github" / "ISSUE_TEMPLATE").mkdir(parents=True)
        (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").write_text("name: Agent task\n")
        (root / ".github" / "workflows").mkdir()
        (root / ".github" / "workflows" / "ci.yml").write_text("name: CI\n")
        (root / ".github" / "workflows" / "coolify-deploy.yml").write_text(delivery_workflow("nest-postgres"))
        (root / "src").mkdir()
        (root / "src" / "health.ts").write_text("const path = '/health';\n")
        return temporary, root

    def test_repository_doctor_accepts_ready_fixture(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        result = run_script("skills/setup-coolify-cicd/scripts/doctor.py", root, "--json", "--run-commands")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads(result.stdout)["ready"])

    def test_repository_doctor_rejects_a_failing_build(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["commands"]["build"] = "false"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/setup-coolify-cicd/scripts/doctor.py", root, "--json", "--run-commands")
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["ready"])

    def test_repository_doctor_requires_stack_delivery_commands(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["commands"].pop("migrateProduction")
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/setup-coolify-cicd/scripts/doctor.py", root, "--json", "--run-commands")
        self.assertEqual(result.returncode, 1)
        self.assertIn("commands.migrateProduction", result.stdout)

    def test_coolify_plan_is_non_mutating_and_has_two_lanes(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        before = (root / ".harness" / "config.json").read_text()
        result = run_script("skills/setup-coolify-cicd/scripts/coolify_reconcile.py", root, "plan")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        actions = json.loads(result.stdout)["actions"]
        self.assertEqual([item["lane"] for item in actions], ["stage", "production"])
        self.assertEqual((root / ".harness" / "config.json").read_text(), before)

    def test_coolify_plan_supports_public_repositories_without_github_app(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["deployment"]["sourceVisibility"] = "public"
        payload["coolify"].pop("githubAppUuid")
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/setup-coolify-cicd/scripts/coolify_reconcile.py", root, "plan")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertNotIn("github_app_uuid", result.stdout)

    def test_coolify_http_error_never_echoes_response_body(self):
        secret = "SYNTHETIC_SECRET_123"

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                body = f"validation failed for value {secret}".encode()
                self.send_response(422)
                self.send_header("content-type", "text/plain")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        module = load_module("skills/setup-coolify-cicd/scripts/coolify_reconcile.py", "coolify_reconcile_redaction")
        client = module.Coolify(f"http://127.0.0.1:{server.server_port}", "test-token")
        with self.assertRaises(RuntimeError) as raised:
            client.request("GET", "/applications")
        self.assertNotIn(secret, str(raised.exception))
        self.assertIn("response body withheld", str(raised.exception))

    def test_workflow_validator_rejects_parallel_migration_and_deploy(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace("needs: migration-stage", "needs: verify"))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("deploy-stage dependencies must be exactly: migration-stage", result.stdout)

    def test_workflow_validator_rejects_noop_and_failure_bypass_jobs(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        valid = workflow_path.read_text()

        workflow_path.write_text(valid.replace("    steps:", "    noop:", 1))
        noop = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(noop.returncode, 1)
        self.assertIn("must declare executable steps", noop.stdout)

        bypass = valid.replace(
            "if: github.ref_name == 'stage'",
            "if: always() && github.ref_name == 'stage'",
            1,
        ).replace("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    continue-on-error: true", 1)
        workflow_path.write_text(bypass)
        rejected = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("exact fail-closed", rejected.stdout)
        self.assertIn("must not use continue-on-error", rejected.stdout)

    def test_workflow_validator_rejects_extra_triggers_and_permissions(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        unsafe = workflow_path.read_text().replace(
            "  workflow_dispatch:",
            "  workflow_dispatch:\n  pull_request_target:",
        ).replace("  contents: read", "  contents: write\n  actions: write")
        workflow_path.write_text(unsafe)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("triggers must be exactly", result.stdout)
        self.assertIn("permissions must be exactly", result.stdout)

    def test_workflow_validator_rejects_verify_permission_override(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "  verify:\n    uses: ./.github/workflows/ci.yml",
            "  verify:\n    permissions: write-all\n    uses: ./.github/workflows/ci.yml",
        ))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("reviewed reusable-workflow template", result.stdout)

    def test_workflow_validator_rejects_gate_step_bypasses(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        valid = workflow_path.read_text()
        mutations = (
            valid.replace("      run: echo migrate-stage", "      run: echo migrate-stage\n      if: ${{ false }}", 1),
            valid.replace("      run: echo migrate-stage", "      run: echo migrate-stage\n      shell: echo {0}", 1),
            valid.replace("    - uses: actions/checkout@v4", "    - uses: actions/checkout@v4\n      with:\n        repository: attacker/evil", 1),
            valid.replace(
                "        DATABASE_URL: ${{ secrets.DATABASE_URL }}",
                "        DATABASE_URL: ${{ secrets.DATABASE_URL }}\n        EXTRA: ${{ secrets['EXTRA'] }}",
                1,
            ),
        )
        for unsafe in mutations:
            with self.subTest(unsafe=unsafe):
                workflow_path.write_text(unsafe)
                result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("differs from the reviewed gate template", result.stdout)

    def test_workflow_validator_rejects_wrong_database_binding_with_dummy_reference(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "        DATABASE_URL: ${{ secrets.DATABASE_URL }}",
            "        DATABASE_URL: ${{ vars.WRONG_DATABASE_URL }}\n        DUMMY: ${{ secrets.DATABASE_URL }}",
            1,
        ))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("differs from the reviewed gate template", result.stdout)

    def test_workflow_validator_rejects_invalid_yaml(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text() + "\nbroken: [\n")
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid workflow YAML", result.stdout)

    def test_workflow_validator_accepts_convex_gate_graph(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["project"]["stack"] = "convex"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(delivery_workflow("convex"))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_workflow_validator_requires_both_hybrid_gates(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["project"]["stack"] = "hybrid"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow = delivery_workflow("hybrid")
        workflow_path.write_text(workflow)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

        workflow_path.write_text(workflow.replace("needs: [migration-production, backend-production]", "needs: migration-production"))
        rejected = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("deploy-production dependencies must be exactly: backend-production, migration-production", rejected.stdout)

    def test_workflow_validator_rejects_extra_deploy_dependency(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "    needs: migration-stage",
            "    needs: [migration-stage, deploy-production]",
            1,
        ))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("dependencies must be exactly: migration-stage", result.stdout)

    def test_workflow_validator_rejects_quoted_extra_job(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "jobs:\n",
            "jobs:\n  \"attacker\":\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo exfiltrate\n",
            1,
        ))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unsupported or quoted job key", result.stdout)

    def test_workflow_validator_rejects_quoted_top_level_key(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text() + '\n"env": { NODE_OPTIONS: evil }\n')
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unsupported or quoted top-level key", result.stdout)

    def test_workflow_validator_rejects_unconfigured_gate_runner(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "    runs-on: ubuntu-latest",
            "    runs-on: ${{ vars.UNCONTROLLED_RUNNER }}",
            1,
        ))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("must use the configured stage gate runner", result.stdout)

        payload = config()
        payload["deployment"]["gateRunners"]["stage"] = "${{ vars.UNCONTROLLED_RUNNER }}"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be a literal reviewed runner label", result.stdout)

    def test_workflow_validator_accepts_explicit_reviewed_gate_runner(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["deployment"]["gateRunners"]["stage"] = "database-stage-runner"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "    runs-on: ubuntu-latest",
            "    runs-on: database-stage-runner",
            1,
        ))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_project_skill_rejects_unsupported_stack(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["project"]["stack"] = "banana"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text((ROOT / "skills/setup-coolify-cicd/assets/coolify-deploy.yml").read_text())
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("project.stack must be", result.stdout)
        doctor = run_script("skills/setup-coolify-cicd/scripts/doctor.py", root, "--json")
        self.assertEqual(doctor.returncode, 1)
        self.assertIn("project.stack must be", doctor.stdout)

    def test_coolify_apply_creates_missing_environments_before_app_patch(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["coolify"]["stage"]["applicationUuid"] = None
        payload["coolify"]["production"]["applicationUuid"] = None
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        requests = []
        application_envs = {"app-stage": set(), "app-production": set()}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, payload):
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                requests.append(("GET", self.path))
                if self.path.endswith("/environments"):
                    self.respond([])
                elif self.path.endswith("/envs"):
                    app_uuid = self.path.split("/")[-2]
                    self.respond([{"key": key} for key in sorted(application_envs[app_uuid])])
                else:
                    def application(lane):
                        return {
                            "uuid": f"app-{lane}", "name": f"service-{lane}",
                            "git_repository": "acme/service", "git_branch": "stage" if lane == "stage" else "main",
                            "project_uuid": "project-1", "server_uuid": "server-1", "environment_name": lane,
                            "build_pack": "dockerfile", "ports_exposes": "3000", "health_check_path": "/health",
                            "health_check_enabled": True,
                            "fqdn": "https://stage.example.test" if lane == "stage" else "https://example.test",
                            "is_auto_deploy_enabled": False, "base_directory": "/", "dockerfile_location": "/Dockerfile",
                        }
                    if self.path.endswith("/applications"):
                        self.respond([application("stage"), application("production")])
                    elif self.path.endswith("/databases"):
                        self.respond([
                            {"uuid": "postgres-stage", "project_uuid": "project-1", "server_uuid": "server-1", "environment_name": "stage"},
                            {"uuid": "postgres-production", "project_uuid": "project-1", "server_uuid": "server-1", "environment_name": "production"},
                        ])
                    elif self.path.endswith("app-stage"):
                        self.respond(application("stage"))
                    else:
                        self.respond(application("production"))

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                requests.append(("POST", self.path, body))
                if self.path.endswith("/envs"):
                    application_envs[self.path.split("/")[-2]].add(body["key"])
                self.respond({"uuid": "environment"})

            def do_PATCH(self):
                requests.append(("PATCH", self.path))
                self.respond({})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        environment = {
            **os.environ,
            "COOLIFY_URL": f"http://127.0.0.1:{server.server_port}",
            "COOLIFY_TOKEN": "test-token",
            "STAGE_DATABASE_URL": "postgres://stage",
            "PRODUCTION_DATABASE_URL": "postgres://production",
        }
        inventory_path = root / "inventory.json"
        inventory_path.write_text(json.dumps({
            **fresh_inventory_metadata(),
            "applications": [
                {"applicationUuid": "app-stage", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage", "name": "service-stage", "repository": "acme/service", "branch": "stage", "domain": "https://stage.example.test"},
                {"applicationUuid": "app-production", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production", "name": "service-production", "repository": "acme/service", "branch": "main", "domain": "https://example.test"},
            ],
            "databases": [
                {"databaseUuid": "postgres-stage", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage"},
                {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production"},
            ],
        }))
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "apply", "--allow-external-writes", "--inventory-json", inventory_path, env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        created = [item[2]["name"] for item in requests if item[0] == "POST" and item[1].endswith("/environments")]
        self.assertEqual(created, ["stage", "production"])
        self.assertEqual(
            [item[2]["key"] for item in requests if item[0] == "POST" and item[1].endswith("/envs")],
            ["DATABASE_URL", "DATABASE_URL"],
        )
        self.assertFalse(any(item[0] == "POST" and item[1].endswith("/applications/private-github-app") for item in requests))
        bound = json.loads((root / ".harness" / "config.json").read_text())["coolify"]
        self.assertEqual((bound["stage"]["applicationUuid"], bound["production"]["applicationUuid"]), ("app-stage", "app-production"))

    def test_coolify_apply_preflights_all_inventory_before_writes(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requests.append(("GET", self.path))
                data = b"[]"
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                requests.append(("POST", self.path))
                self.send_response(500)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        inventory_path = root / "inventory.json"
        inventory_path.write_text(json.dumps({
            **fresh_inventory_metadata(),
            "applications": [],
            "databases": [
                {"databaseUuid": "postgres-stage", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage"},
                {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production"},
            ],
        }))
        environment = {
            **os.environ,
            "COOLIFY_URL": f"http://127.0.0.1:{server.server_port}",
            "COOLIFY_TOKEN": "test-token",
            "STAGE_DATABASE_URL": "postgres://stage",
            "PRODUCTION_DATABASE_URL": "postgres://production",
        }
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "apply", "--allow-external-writes", "--inventory-json", inventory_path, env=environment,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(any(method == "POST" for method, _path in requests), requests)

    def test_coolify_database_inventory_must_prove_postgresql(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        inventory_path = root / "inventory.json"
        inventory_path.write_text(json.dumps({
            **fresh_inventory_metadata(),
            "applications": [{"applicationUuid": "unused"}],
            "databases": [
                {"databaseUuid": "postgres-stage", "databaseType": "mysql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage"},
                {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production"},
            ],
        }))
        environment = {**os.environ, "COOLIFY_URL": "http://127.0.0.1:1", "COOLIFY_TOKEN": "test-token"}
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "verify", "--inventory-json", inventory_path, env=environment,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("databaseType", result.stderr)

    def test_existing_environment_key_requires_value_fingerprint(self):
        module = load_module("skills/setup-coolify-cicd/scripts/coolify_reconcile.py", "coolify_reconcile_test")
        expected = "postgres://stage"
        self.assertTrue(module.environment_value_verified(
            [{"applicationUuid": "app-stage", "key": "DATABASE_URL", "valueSha256": hashlib.sha256(expected.encode()).hexdigest()}],
            "app-stage", "DATABASE_URL", expected,
        ))
        self.assertFalse(module.environment_value_verified(
            [{"applicationUuid": "app-stage", "key": "DATABASE_URL", "valueSha256": hashlib.sha256(b"wrong").hexdigest()}],
            "app-stage", "DATABASE_URL", expected,
        ))

    def test_label_plan_uses_runtime_contract(self):
        result = run_script("skills/deploy-issue-harness-agent/scripts/github_labels.py", "acme/service", "plan")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        names = [item["name"] for item in json.loads(result.stdout)["labels"]]
        self.assertEqual(names, ["ai:backlog", "ai:todo", "ai:running", "ai:finished", "ai:needs-human", "production:diagnose"])

    def test_deployment_assets_wait_for_commit_and_share_host_paths(self):
        workflow = (ROOT / "skills/setup-coolify-cicd/assets/coolify-deploy.yml").read_text()
        compose = (ROOT / "skills/deploy-issue-harness-agent/assets/coolify-agent-compose.yml").read_text()
        self.assertEqual(workflow.count("/api/v1/deployments/${deployment_uuid}"), 2)
        self.assertIn("$GITHUB_SHA", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("${HARNESS_DATA_DIR:?set /opt/issue-harness/owner-repository}:${HARNESS_DATA_DIR:?set /opt/issue-harness/owner-repository}", compose)
        self.assertNotIn("harness-data:/data", compose)
        self.assertIn("__HARNESS_CONVEX_DEPLOY_STAGE__", (ROOT / "skills/setup-coolify-cicd/assets/convex-delivery-jobs.yml").read_text())
        self.assertIn("__HARNESS_MIGRATE_PRODUCTION__", (ROOT / "skills/setup-coolify-cicd/assets/nest-migration-jobs.yml").read_text())

    def test_diagnostics_verifier_rejects_cross_origin_secret_routing(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["observability"] = {"provider": "loki-gateway", "service": "api", "environment": "production"}
        payload["productionAgent"] = {
            "mode": "diagnose-only",
            "allowedTools": ["health.read", "logs.query", "traces.query", "metrics.query", "deploy.status"],
            "mutationPath": "none",
        }
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        environment = {**os.environ, "DIAGNOSTICS_TOKEN": "do-not-send"}
        result = run_script(
            "skills/deploy-issue-harness-agent/scripts/verify_diagnostics.py",
            root,
            "--allowed-origin", "https://diagnostics.example.test",
            "--health-url", "https://evil.example.test/health",
            "--query-url", "https://diagnostics.example.test/query",
            "--policy-check-url", "https://diagnostics.example.test/policy",
            "--credential-env", "DIAGNOSTICS_TOKEN",
            env=environment,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("allowed origin", result.stderr)

    def test_diagnostics_verifier_rejects_mutating_agent_tools(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["observability"] = {"provider": "loki-gateway", "service": "api", "environment": "production"}
        payload["productionAgent"] = {
            "mode": "diagnose-only",
            "allowedTools": ["health.read", "logs.query", "shell"],
            "mutationPath": "none",
        }
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script(
            "skills/deploy-issue-harness-agent/scripts/verify_diagnostics.py",
            root,
            "--allowed-origin", "https://diagnostics.example.test",
            "--health-url", "https://diagnostics.example.test/health",
            "--query-url", "https://diagnostics.example.test/query",
            "--policy-check-url", "https://diagnostics.example.test/policy",
            "--credential-env", "DIAGNOSTICS_TOKEN",
            env={**os.environ, "DIAGNOSTICS_TOKEN": "test-only"},
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("non-read-only tools: shell", result.stderr)

    def test_agent_validator_accepts_bound_fixture(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        agent = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(agent.returncode, 0, agent.stderr + agent.stdout)

    def test_agent_validator_rejects_missing_repository_assets_and_unsafe_host(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        (root / ".sandcastle" / "prompt.md").unlink()
        (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").unlink()
        payload = config()
        payload["issueAgent"]["dedicatedAutomationHost"] = False
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(any("prompt.md" in error for error in report["errors"]))
        self.assertTrue(any("agent-task.yml" in error for error in report["errors"]))
        self.assertTrue(any("dedicatedAutomationHost" in error for error in report["errors"]))

    def test_agent_validator_rejects_latest_and_shared_host(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["sandboxImage"] = "sandbox:latest"
        payload["issueAgent"]["dedicatedAutomationHost"] = False
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertTrue(any("sha256" in item for item in report["errors"]))
        self.assertTrue(any("dedicatedAutomationHost" in item for item in report["errors"]))

    def test_agent_validator_rejects_shared_data_root(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["dataDir"] = "/var/lib"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        self.assertIn("per-repository child", result.stdout)

    def test_agent_inventory_rejects_and_never_echoes_extra_secret_fields(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                payload = json.dumps({
                    "status": "ok",
                    "repository": "acme/service",
                    "workspaceOrigin": "https://github.com/acme/service.git",
                }).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        issue = config()["issueAgent"]
        secret = "github_pat_must_not_be_printed"
        inventory_path = root / "agent-inventory.json"
        inventory_path.write_text(json.dumps({
            "applicationUuid": issue["applicationUuid"],
            "serverUuid": issue["serverUuid"],
            "harnessImage": issue["harnessImage"],
            "sandboxImage": issue["sandboxImage"],
            "dataDir": issue["dataDir"],
            "replicas": 1,
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source": "coolify-api",
            "GITHUB_TOKEN": secret,
        }))
        result = run_script(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            root,
            "--health-url", f"http://127.0.0.1:{server.server_port}/health",
            "--inventory-json", inventory_path,
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(secret, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertFalse(report["inventoryVerified"])
        self.assertTrue(any("unsupported fields" in error for error in report["errors"]))


if __name__ == "__main__":
    unittest.main()
