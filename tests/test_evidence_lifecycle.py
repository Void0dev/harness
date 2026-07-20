import hashlib
import json
import os
import pathlib
import stat
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SETUP = ROOT / "skills" / "setup-coolify-cicd"


def load_ledger():
    import importlib.util
    import sys

    path = SETUP / "evidence_ledger.py"
    sys.path.insert(0, str(SETUP))
    spec = importlib.util.spec_from_file_location("evidence_ledger_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


REPO = "acme/service"
HEALTH = "https://stage.example.test/ready"


def producer(run_id=100, workflow=".github/workflows/coolify-deploy.yml"):
    return {
        "runId": run_id,
        "runAttempt": 1,
        "workflowPath": workflow,
        "workflowRef": f"{REPO}/{workflow}@refs/heads/main",
        "sourceRef": "refs/heads/main",
        "sourceSha": "f" * 40,
        "event": "workflow_run",
    }


def locator(sequence=0, run_id=100, artifact_id=200, name=None, sha="1" * 64):
    return {
        "repository": REPO,
        "runId": run_id,
        "artifactId": artifact_id,
        "artifactName": name or f"deployment-stage-{sequence}",
        "fileName": "evidence.json",
        "sha256": sha,
    }


def deployment(sequence=0, predecessor=None, revision="a" * 40, run_id=100):
    return {
        "schema": "deployment-success-v1",
        "repository": REPO,
        "lane": "stage",
        "provider": "coolify",
        "resourceUuid": "app-stage",
        "revision": revision,
        "deploymentUuid": f"deployment-{sequence}",
        "healthUrlSha256": hashlib.sha256(HEALTH.encode()).hexdigest(),
        "healthVerified": True,
        "autoDeployDisabled": True,
        "sequence": sequence,
        "predecessor": predecessor,
        "target": {
            "revision": revision,
            "ciRunId": 77,
            "ciWorkflowPath": ".github/workflows/ci.yml",
        },
        "producer": producer(run_id),
        "outcome": "deployment-succeeded",
    }


class FakeRunner:
    def __init__(self, record, artifact=None, run=None, attest_ok=True):
        self.record = record
        self.raw = None
        self.commands = []
        self.artifact = artifact or {
            "id": 200,
            "name": "deployment-stage-0",
            "expired": False,
            "workflow_run": {"id": 100, "head_branch": "main", "head_sha": "f" * 40},
        }
        self.run = run or {
            "id": 100,
            "run_attempt": 1,
            "head_branch": "main",
            "head_sha": "f" * 40,
            "event": "workflow_run",
            "status": "completed",
            "conclusion": "success",
            "path": ".github/workflows/coolify-deploy.yml",
        }
        self.attest_ok = attest_ok

    def __call__(self, command, *, cwd=None):
        self.commands.append(command)
        if command[:2] == ["gh", "api"]:
            return json.dumps(self.artifact if "/actions/artifacts/" in command[2] else self.run)
        if command[:3] == ["gh", "run", "download"]:
            target = pathlib.Path(command[command.index("--dir") + 1])
            target.mkdir(parents=True, exist_ok=True)
            raw = self.raw or load_ledger().canonical_json(self.record)
            (target / "evidence.json").write_bytes(raw)
            return ""
        if command[:3] == ["gh", "attestation", "verify"]:
            if not self.attest_ok:
                raise RuntimeError("attestation rejected")
            return "verified"
        raise AssertionError(command)


class EvidenceLifecycleTest(unittest.TestCase):
    def test_compiler_emits_five_authenticated_lifecycle_workflows(self):
        import importlib.util
        import sys

        config_path = SETUP / "harness_config.py"
        sys.path.insert(0, str(SETUP))
        spec = importlib.util.spec_from_file_location("g016_config", config_path)
        config_module = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(config_module)
        config = config_module.normalize_config(
            json.loads((SETUP / "assets" / "config.example.json").read_text())
        )
        compiled = config_module.compile_workflows(config, SETUP / "assets")
        self.assertEqual(set(compiled), {
            "ci.yml",
            "coolify-deploy.yml",
            "backend-prepare.yml",
            "coolify-rollback.yml",
            "bootstrap-deployment-evidence.yml",
        })
        deploy = compiled["coolify-deploy.yml"]
        self.assertIn("workflow_run:", deploy)
        self.assertNotIn("  push:", deploy)
        self.assertIn("github.event.workflow_run.head_sha", deploy)
        self.assertIn("github.event.workflow_run.head_branch == 'stage'", deploy)
        self.assertIn("deployment_evidence_run_id", deploy)
        self.assertIn("backend_evidence_run_id", deploy)
        self.assertNotIn("POSTGRES_PREPARED_REVISION", deploy)
        self.assertIn("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6", deploy)
        self.assertIn("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", deploy)
        self.assertIn("Compensate to verified predecessor", deploy)

        rollback = compiled["coolify-rollback.yml"]
        self.assertNotIn("rollback_revision", rollback)
        self.assertIn("target_evidence_run_id", rollback)
        self.assertIn("derive-rollback", rollback)

        backend = compiled["backend-prepare.yml"]
        self.assertIn("backend-release-v1", backend)
        self.assertIn("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6", backend)
        self.assertIn("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", backend)

        bootstrap = compiled["bootstrap-deployment-evidence.yml"]
        self.assertIn("import-existing", bootstrap)
        self.assertIn("initialize-empty", bootstrap)
        self.assertIn("empty-observation-v1", bootstrap)
        self.assertIn("environment: ${{ inputs.lane }}", bootstrap)

    def test_exact_schema_canonical_json_and_secure_staging(self):
        ledger = load_ledger()
        record = deployment()
        ledger.validate_record(record)
        raw = ledger.canonical_json(record)
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(json.loads(raw), record)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "evidence.json"
            ledger.secure_stage_record(record, path)
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_empty_observation_never_authorizes_deploy_or_rollback(self):
        ledger = load_ledger()
        empty = ledger.bootstrap_empty_observation(
            repository=REPO,
            lane="stage",
            provider="coolify",
            resource_uuid="app-stage",
            health_url=HEALTH,
            producer=producer(workflow=".github/workflows/bootstrap-deployment-evidence.yml"),
        )
        ledger.validate_record(empty)
        with self.assertRaisesRegex(ValueError, "cannot authorize"):
            ledger.authorize_deployment_predecessor(empty)
        with self.assertRaisesRegex(ValueError, "cannot authorize"):
            ledger.derive_rollback_revision(empty)

    def test_import_existing_requires_exact_live_success_and_health(self):
        ledger = load_ledger()
        observation = {
            "resourceUuid": "app-stage",
            "revision": "a" * 40,
            "deploymentUuid": "deployment-0",
            "status": "finished",
            "autoDeployDisabled": True,
            "healthVerified": True,
            "healthUrlSha256": hashlib.sha256(HEALTH.encode()).hexdigest(),
            "provider": "coolify",
        }
        record = ledger.bootstrap_import_existing(
            observation,
            repository=REPO,
            lane="stage",
            resource_uuid="app-stage",
            expected_revision="a" * 40,
            health_url=HEALTH,
            producer=producer(workflow=".github/workflows/bootstrap-deployment-evidence.yml"),
        )
        self.assertEqual(record["sequence"], 0)
        for change, message in (
            ({"healthVerified": False}, "health"),
            ({"revision": "b" * 40}, "revision"),
            ({"resourceUuid": "other"}, "resource"),
            ({"status": "failed"}, "successful"),
            ({"autoDeployDisabled": False}, "auto deploy"),
        ):
            invalid = {**observation, **change}
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                ledger.bootstrap_import_existing(
                    invalid,
                    repository=REPO,
                    lane="stage",
                    resource_uuid="app-stage",
                    expected_revision="a" * 40,
                    health_url=HEALTH,
                    producer=producer(workflow=".github/workflows/bootstrap-deployment-evidence.yml"),
                )

    def test_sequence_predecessor_fork_and_consumption_replay_fail_closed(self):
        ledger = load_ledger()
        head0 = deployment()
        loc0 = locator(sha=hashlib.sha256(ledger.canonical_json(head0)).hexdigest())
        head1 = deployment(1, loc0, "b" * 40, 101)
        ledger.validate_successor(head0, loc0, head1)
        fork = deployment(1, loc0, "c" * 40, 102)
        with self.assertRaisesRegex(ValueError, "fork"):
            ledger.resolve_unique_head([(loc0, head0), (locator(1, 101, 201), head1), (locator(1, 102, 202), fork)])

        backend = {
            "schema": "backend-release-v1",
            "repository": REPO,
            "lane": "production",
            "provider": "aggregate",
            "releaseRevision": "b" * 40,
            "capabilities": [{
                "capabilityId": "postgres",
                "kind": "coolify.postgresql",
                "provider": "coolify-postgresql",
                "resourceRef": "postgres-production",
                "previousRevision": "migration-41",
                "backupRef": "backup-42",
                "receiptSha256": "2" * 64,
                "outcome": "prepared-expand-only",
            }],
            "sequence": 0,
            "predecessor": None,
            "producer": producer(300, ".github/workflows/backend-prepare.yml"),
            "outcome": "backend-release-succeeded",
        }
        ledger.validate_record(backend)
        backend_loc = locator(0, 300, 400, "backend-release-0", "3" * 64)
        consumption = ledger.build_consumption_record(
            repository=REPO,
            application_revision="b" * 40,
            resource_uuid="app-production",
            deployment_evidence=locator(1, 101, 201),
            backend_evidence=backend_loc,
            producer=producer(500),
            sequence=0,
            predecessor=None,
        )
        ledger.validate_consumption(consumption, [], backend)
        with self.assertRaisesRegex(ValueError, "replay"):
            ledger.validate_consumption(consumption, [consumption], backend)

    def test_artifact_adapter_rejects_expiry_attestation_context_and_wrong_live_state(self):
        ledger = load_ledger()
        record = deployment()
        raw_sha = hashlib.sha256(ledger.canonical_json(record)).hexdigest()
        loc = locator(sha=raw_sha)

        def live(_record):
            return {
                "provider": "coolify",
                "resourceUuid": "app-stage",
                "revision": "a" * 40,
                "deploymentUuid": "deployment-0",
                "healthUrlSha256": hashlib.sha256(HEALTH.encode()).hexdigest(),
                "healthVerified": True,
                "autoDeployDisabled": True,
            }

        runner = FakeRunner(record)
        adapter = ledger.GitHubArtifactAdapter(runner=runner, live_readback=live)
        resolved = adapter.resolve(loc, expected_schema="deployment-success-v1", expected_lane="stage")
        self.assertEqual(resolved, record)
        attest = next(command for command in runner.commands if command[:3] == ["gh", "attestation", "verify"])
        self.assertIn("--signer-workflow", attest)
        self.assertIn(f"{REPO}/.github/workflows/coolify-deploy.yml@refs/heads/main", attest)
        self.assertIn("--source-ref", attest)
        self.assertIn("refs/heads/main", attest)

        cases = []
        cases.append((FakeRunner(record, artifact={**runner.artifact, "expired": True}), live, "expired"))
        cases.append((FakeRunner(record, attest_ok=False), live, "attestation"))
        wrong_signer = {**record, "producer": {**record["producer"], "workflowRef": f"{REPO}/.github/workflows/coolify-deploy.yml@refs/heads/stage"}}
        cases.append((FakeRunner(wrong_signer), live, "workflowRef"))
        cases.append((FakeRunner(record), lambda _record: {**live(_record), "resourceUuid": "other"}, "live"))
        for failing_runner, live_reader, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex((ValueError, RuntimeError), message):
                raw = ledger.canonical_json(failing_runner.record)
                bad_locator = {**loc, "sha256": hashlib.sha256(raw).hexdigest()}
                ledger.GitHubArtifactAdapter(
                    runner=failing_runner,
                    live_readback=live_reader,
                ).resolve(bad_locator, expected_schema="deployment-success-v1", expected_lane="stage")

    def test_manual_rollback_derives_revision_only_from_verified_deployed_record(self):
        ledger = load_ledger()
        self.assertEqual(ledger.derive_rollback_revision(deployment()), "a" * 40)
        with self.assertRaisesRegex(ValueError, "full Git"):
            ledger.derive_rollback_revision({**deployment(), "revision": "main"})


if __name__ == "__main__":
    unittest.main()
