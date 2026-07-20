import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SETUP = ROOT / "skills" / "setup-coolify-cicd"


def load(relative: str, name: str):
    path = SETUP / relative
    sys.path.insert(0, str(path.parent))
    sys.path.insert(0, str(SETUP))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def trusted_success_record(resource_uuid: str, revision: str, health_url: str) -> dict:
    return {
        "schemaVersion": 1,
        "recordType": "coolify-exact-deployment",
        "writer": "project-harness/deploy_exact_revision.py",
        "resourceUuid": resource_uuid,
        "revision": revision,
        "deploymentUuid": "deployment-prior",
        "healthUrlSha256": hashlib.sha256(health_url.encode()).hexdigest(),
        "healthVerified": True,
        "outcome": "deployment-succeeded",
    }


class RolloutApi:
    def __init__(self, failure: str, rollback_failure: bool = False):
        self.failure = failure
        self.rollback_failure = rollback_failure
        self.previous = "b" * 40
        self.target = "a" * 40
        self.pin = self.previous
        self.deploys = 0
        self.patches = []

    @staticmethod
    def literal_path(*segments):
        return "/" + "/".join(segments)

    def version(self):
        return "v4.1.2"

    def request(self, method, path, body=None):
        if path == "/deployments/deployment-prior" and method == "GET":
            return {
                "status": "finished",
                "commit": self.previous,
                "resource_uuid": "app-stage",
            }
        if path == "/applications/app-stage" and method == "GET":
            return {"git_commit_sha": self.pin, "is_auto_deploy_enabled": False}
        if path == "/applications/app-stage" and method == "PATCH":
            self.pin = body["git_commit_sha"]
            self.patches.append(self.pin)
            return {"uuid": "app-stage"}
        if path == "/deploy" and method == "POST":
            self.deploys += 1
            is_rollback = self.deploys > 1
            if (self.failure == "queue" and not is_rollback) or (self.rollback_failure and is_rollback):
                return {"deployments": []}
            return {"deployments": [{
                "resource_uuid": "app-stage",
                "deployment_uuid": f"deployment-{self.deploys}",
            }]}
        if path.startswith("/deployments/") and method == "GET":
            is_rollback = path.endswith("-2")
            if self.failure == "status" and not is_rollback:
                return {"status": "failed", "commit": self.target}
            commit = self.pin
            if self.failure == "commit" and not is_rollback:
                commit = "c" * 40
            return {"status": "finished", "commit": commit}
        raise AssertionError((method, path, body))


class DeploymentSafetyTest(unittest.TestCase):
    def test_every_post_pin_failure_rolls_back_full_revision_and_health(self):
        module = load("assets/deploy_exact_revision.py", "deployment_rollback_boundaries")
        for failure in ("queue", "status", "commit", "health"):
            with self.subTest(failure=failure):
                api = RolloutApi(failure)
                recorded = []
                outcomes = []
                health_calls = []

                def health(url):
                    health_calls.append((url, api.pin))
                    if failure == "health" and api.pin == api.target:
                        raise RuntimeError("new revision unhealthy")

                with self.assertRaisesRegex(RuntimeError, "automatic rollback"):
                    module.deploy_exact_revision(
                        api,
                        "app-stage",
                        api.target,
                        "https://stage.example.test/ready",
                        health_probe=health,
                        sleep=lambda _seconds: None,
                        attempts=1,
                        rollback_evidence=trusted_success_record(
                            "app-stage", api.previous, "https://stage.example.test/ready"
                        ),
                        record_success=recorded.append,
                        record_event=outcomes.append,
                    )
                self.assertEqual(api.pin, api.previous)
                self.assertEqual(api.patches, [api.target, api.previous])
                self.assertEqual(recorded[-1]["revision"], api.previous)
                self.assertEqual(recorded[-1]["deploymentUuid"], "deployment-2")
                self.assertEqual(outcomes[-1]["outcome"], "rollback-succeeded")
                self.assertTrue(health_calls)
                self.assertEqual(health_calls[-1][1], api.previous)

    def test_rollback_failure_has_distinct_error(self):
        module = load("assets/deploy_exact_revision.py", "deployment_rollback_failed")
        api = RolloutApi("status", rollback_failure=True)
        outcomes = []
        with self.assertRaisesRegex(module.RollbackFailedError, "ROLLBACK_FAILED"):
            module.deploy_exact_revision(
                api,
                "app-stage",
                api.target,
                "https://stage.example.test/ready",
                health_probe=lambda _url: None,
                sleep=lambda _seconds: None,
                attempts=1,
                rollback_evidence=trusted_success_record(
                    "app-stage", api.previous, "https://stage.example.test/ready"
                ),
                record_event=outcomes.append,
            )
        self.assertEqual(outcomes[-1]["outcome"], "rollback-failed")

    def test_exact_deploy_refuses_missing_mismatched_or_corrupt_success_evidence(self):
        module = load("assets/deploy_exact_revision.py", "deployment_trusted_evidence")
        api = RolloutApi("none")
        health_url = "https://stage.example.test/ready"
        with self.assertRaisesRegex(RuntimeError, "trusted rollback evidence is required"):
            module.deploy_exact_revision(
                api,
                "app-stage",
                api.target,
                health_url,
                health_probe=lambda _url: None,
                sleep=lambda _seconds: None,
            )
        self.assertEqual(api.patches, [])

        base = trusted_success_record("app-stage", api.previous, health_url)
        cases = (
            ({**base, "resourceUuid": "other-app"}, "resource UUID"),
            ({**base, "healthUrlSha256": "0" * 64}, "health URL"),
            ({**base, "outcome": "rollback-failed"}, "trusted successful outcome"),
            ({**base, "deploymentUuid": "../ambiguous"}, "deployment UUID"),
        )
        for evidence, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                module.deploy_exact_revision(
                    api,
                    "app-stage",
                    api.target,
                    health_url,
                    health_probe=lambda _url: None,
                    sleep=lambda _seconds: None,
                    rollback_evidence=evidence,
                )
        self.assertEqual(api.patches, [])

        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "evidence.json"
            path.write_text("{not-json")
            path.chmod(0o600)
            with self.assertRaisesRegex(ValueError, "invalid JSON"):
                module.load_successful_deployment_record(path, "app-stage", health_url)

    def test_split_deploy_credentials_must_be_distinct(self):
        module = load("assets/deploy_exact_revision.py", "deployment_split_credentials")
        original_argv = sys.argv
        environment = os.environ.copy()
        try:
            sys.argv = [
                "deploy_exact_revision.py",
                "--resource-uuid", "app-stage",
                "--revision", "a" * 40,
                "--health-url", "https://stage.example.test/ready",
            ]
            os.environ.update({
                "COOLIFY_URL": "https://coolify.example.test",
                "COOLIFY_PIN_TOKEN": "same-token",
                "COOLIFY_DEPLOY_TOKEN": "same-token",
            })
            with self.assertRaisesRegex(ValueError, "distinct credentials"):
                module.main()
        finally:
            sys.argv = original_argv
            os.environ.clear()
            os.environ.update(environment)

    def test_coolify_paths_and_harness_paths_reject_normalization_ambiguity(self):
        client = load("assets/coolify_client.py", "strict_coolify_paths")
        safety = load("harness_safety.py", "strict_harness_paths")
        for path in ("/applications/../secret", "/applications/%2e%2e/secret", "/applications//app", "/applications/app\\envs"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                client.CoolifyClient._validate_path(path)
        self.assertEqual(client.CoolifyClient.literal_path("applications", "app-stage"), "/applications/app-stage")
        for path in ("../service", "service/../api", "service/%2e%2e/api", "service\\api", "/service"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                safety.validate_relative_posix_path(path, "root")

    def test_unknown_capability_fails_compiler_and_manual_prepare_is_serialized(self):
        config_module = load("harness_config.py", "safety_config")
        compiler = load("workflow_compiler.py", "safety_compiler")
        raw = json.loads((SETUP / "assets" / "config.example.json").read_text())
        normalized = config_module.normalize_config(raw)
        manual = compiler.compile_backend_prepare_workflow(normalized, SETUP / "assets")
        self.assertIn("needs: postgres-prepare-production", manual)
        self.assertIn("environment: production", manual)
        self.assertNotIn("__HARNESS_", manual)
        rollback = (SETUP / "assets" / "coolify-rollback.yml").read_text()
        self.assertIn("environment: production", rollback)
        self.assertIn('--revision "$ROLLBACK_REVISION"', rollback)
        self.assertNotIn("secrets.COOLIFY_TOKEN", rollback)
        unknown = json.loads(json.dumps(normalized))
        unknown["capabilities"].append({
            **unknown["capabilities"][0],
            "id": "mystery",
            "kind": "unknown.backend",
        })
        with self.assertRaisesRegex(ValueError, "registered compiler/verifier"):
            compiler.compile_workflows(unknown, SETUP / "assets")

    def test_offline_plan_tolerates_unresolved_bindings_and_reports_all_lanes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / ".harness").mkdir()
            (root / ".harness" / "config.json").write_bytes(
                (SETUP / "assets" / "config.example.json").read_bytes()
            )
            result = subprocess.run(
                ["python3", str(SETUP / "scripts" / "coolify_reconcile.py"), str(root), "plan"],
                text=True,
                capture_output=True,
                env={**os.environ, "COOLIFY_URL": "", "COOLIFY_TOKEN": ""},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertFalse(report["externalAccess"])
            self.assertEqual([item["lane"] for item in report["actions"]], ["stage", "production"])
            self.assertEqual({item["category"] for item in report["backendActions"]}, {"postgresql", "convex"})
            self.assertEqual({item["lane"] for item in report["credentialActions"]}, {"stage", "production"})
            self.assertIn("contractMigration", report["approvalActions"][1])

    def test_recovery_journal_restores_interrupted_write(self):
        io = load("harness_io.py", "migration_crash_recovery")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            harness = root / ".harness"
            harness.mkdir()
            target = harness / "config.json"
            original = b'{"schemaVersion":1}\n'
            target.write_bytes(b'{"schemaVersion":2}\n')
            journal = {
                "version": 1,
                "state": "prepared",
                "files": [{
                    "path": ".harness/config.json",
                    "existed": True,
                    "mode": 0o600,
                    "originalBase64": base64.b64encode(original).decode(),
                    "originalSha256": hashlib.sha256(original).hexdigest(),
                }],
            }
            (harness / io.JOURNAL_NAME).write_text(json.dumps(journal))
            self.assertTrue(io.recover_pending_write(root))
            self.assertEqual(target.read_bytes(), original)
            self.assertFalse((harness / io.JOURNAL_NAME).exists())

    def test_migration_write_auto_recovers_crash_state_before_rendering(self):
        io = load("harness_io.py", "migration_auto_crash_recovery")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            harness = root / ".harness"
            harness.mkdir()
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            target = harness / "config.json"
            original = (SETUP / "assets" / "config.example.json").read_bytes()
            target.write_bytes(b"{}\n")
            journal = {
                "version": 1,
                "state": "prepared",
                "files": [{
                    "path": ".harness/config.json",
                    "existed": True,
                    "mode": 0o600,
                    "originalBase64": base64.b64encode(original).decode(),
                    "originalSha256": hashlib.sha256(original).hexdigest(),
                }],
            }
            (harness / io.JOURNAL_NAME).write_text(json.dumps(journal))
            result = subprocess.run(
                ["python3", str(SETUP / "scripts" / "migrate_harness.py"), str(root), "--write"],
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["recoveredInterruptedWrite"])
            self.assertEqual(json.loads(target.read_text())["schemaVersion"], 2)
            self.assertFalse((harness / io.JOURNAL_NAME).exists())


if __name__ == "__main__":
    unittest.main()
