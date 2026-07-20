import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone


ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / "skills" / "setup-coolify-cicd" / "evidence_ledger.py"
REPOSITORY = "acme/service"
HEALTH_URL = "https://production.example.test/ready"
SOURCE_SHA = "f" * 40
TARGET_SHA = "a" * 40
NEXT_SHA = "b" * 40

COMMANDS = {
    "validate",
    "resolve-stage-head",
    "resolve-locator",
    "successor",
    "consume",
    "derive-rollback",
    "compensate",
    "bootstrap-import-existing",
    "bootstrap-empty",
    "backend-receipt",
    "aggregate-backend",
    "verify-backend-capability",
    "assert-bootstrap-available",
    "create-retention-checkpoint",
    "published-locator",
}


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def producer(
    *,
    run_id=41,
    workflow=".github/workflows/coolify-deploy.yml",
    event="workflow_dispatch",
):
    return {
        "runId": run_id,
        "runAttempt": 1,
        "workflowPath": workflow,
        "workflowRef": f"{REPOSITORY}/{workflow}@refs/heads/main",
        "sourceRef": "refs/heads/main",
        "sourceSha": SOURCE_SHA,
        "event": event,
    }


def locator(record, *, run_id=41, artifact_id=51, artifact_name="deployment-production-41-1"):
    return {
        "repository": REPOSITORY,
        "runId": run_id,
        "artifactId": artifact_id,
        "artifactName": artifact_name,
        "fileName": "evidence.json",
        "sha256": hashlib.sha256(canonical(record)).hexdigest(),
    }


def deployment(
    *,
    sequence=0,
    revision=TARGET_SHA,
    predecessor=None,
    run_id=41,
    lane="production",
    resource_uuid="app-production",
    deployment_uuid="deployment-0",
):
    return {
        "schema": "deployment-success-v1",
        "repository": REPOSITORY,
        "lane": lane,
        "provider": "coolify",
        "resourceUuid": resource_uuid,
        "revision": revision,
        "deploymentUuid": deployment_uuid,
        "healthUrlSha256": hashlib.sha256(HEALTH_URL.encode()).hexdigest(),
        "healthVerified": True,
        "autoDeployDisabled": True,
        "sequence": sequence,
        "predecessor": predecessor,
        "target": {
            "revision": revision,
            "ciRunId": 77 if lane == "stage" else None,
            "ciWorkflowPath": ".github/workflows/ci.yml" if lane == "stage" else None,
        },
        "producer": producer(run_id=run_id),
        "outcome": "deployment-succeeded",
    }


def deploy_record(*, revision=TARGET_SHA, deployment_uuid="deployment-0"):
    return {
        "schemaVersion": 1,
        "recordType": "coolify-exact-deployment",
        "writer": "project-harness/deploy_exact_revision.py",
        "resourceUuid": "app-production",
        "revision": revision,
        "deploymentUuid": deployment_uuid,
        "healthUrlSha256": hashlib.sha256(HEALTH_URL.encode()).hexdigest(),
        "healthVerified": True,
        "outcome": "deployment-succeeded",
    }


def github_environment(*, workflow=".github/workflows/coolify-deploy.yml", run_id=91):
    return {
        "GITHUB_REPOSITORY": REPOSITORY,
        "GITHUB_RUN_ID": str(run_id),
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_WORKFLOW_REF": f"{REPOSITORY}/{workflow}@refs/heads/main",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": SOURCE_SHA,
        "GITHUB_EVENT_NAME": "workflow_dispatch",
    }


class EvidenceLedgerCliTest(unittest.TestCase):
    maxDiff = None

    def run_cli(self, *arguments, env=None, cli=CLI, cwd=None):
        environment = os.environ.copy()
        environment.update(env or {})
        return subprocess.run(
            ["python3", str(cli), *map(str, arguments)],
            cwd=cwd,
            env=environment,
            text=True,
            capture_output=True,
            timeout=20,
        )

    def write_json(self, path, value):
        path.write_bytes(canonical(value))
        path.chmod(0o600)

    def install_fake_gh(
        self,
        directory,
        *,
        record=None,
        empty_list=False,
        fail_attestation=False,
        artifact_name="deployment-production-41-1",
        workflow_path=".github/workflows/coolify-deploy.yml",
    ):
        bin_dir = pathlib.Path(directory) / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        raw_literal = repr(canonical(record).decode() if record is not None else "")
        script = f"""#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
raw = {raw_literal}
artifact = {{"id": 51, "name": {artifact_name!r}, "expired": False, "workflow_run": {{"id": 41}}}}
run = {{"id": 41, "run_attempt": 1, "head_branch": "main", "head_sha": {SOURCE_SHA!r}, "event": "workflow_dispatch", "status": "completed", "conclusion": "success", "path": {workflow_path!r} + "@main"}}
if args[:1] == ["api"] and "/actions/artifacts/51" in args[1]:
    print(json.dumps(artifact))
elif args[:1] == ["api"] and "/actions/runs/41" in args[1]:
    print(json.dumps(run))
elif args[:1] == ["api"] and "/actions/artifacts" in args[1]:
    print(json.dumps([{{"total_count": 0, "artifacts": []}}] if {empty_list!r} else [{{"total_count": 1, "artifacts": [artifact]}}]))
elif args[:2] == ["run", "download"]:
    target = pathlib.Path(args[args.index("--dir") + 1])
    target.mkdir(parents=True, exist_ok=True)
    (target / "evidence.json").write_text(raw)
elif args[:2] == ["attestation", "verify"]:
    sys.exit(1 if {fail_attestation!r} else 0)
else:
    raise SystemExit(9)
"""
        gh.write_text(script)
        gh.chmod(0o700)
        return str(bin_dir) + os.pathsep + os.environ.get("PATH", "")

    def install_fake_gh_inventory(self, directory, entries):
        bin_dir = pathlib.Path(directory) / "inventory-bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        payload = []
        for artifact_id, run_id, artifact_name, record, expired, *outcome in entries:
            producer_record = record["producer"]
            payload.append({
                "artifact": {
                    "id": artifact_id,
                    "name": artifact_name,
                    "expired": expired,
                    "workflow_run": {"id": run_id},
                },
                "run": {
                    "id": run_id,
                    "run_attempt": producer_record["runAttempt"],
                    "head_branch": "main",
                    "head_sha": producer_record["sourceSha"],
                    "event": producer_record["event"],
                    "status": "completed",
                    "conclusion": outcome[0] if outcome else "success",
                    "path": producer_record["workflowPath"] + "@main",
                },
                "raw": canonical(record).decode(),
            })
        script = f"""#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
items = {payload!r}
if args[:1] == ["api"] and "/actions/artifacts/" in args[1]:
    artifact_id = int(args[1].rsplit("/", 1)[1])
    print(json.dumps(next(item["artifact"] for item in items if item["artifact"]["id"] == artifact_id)))
elif args[:1] == ["api"] and "/actions/runs/" in args[1]:
    run_id = int(args[1].rsplit("/", 1)[1])
    print(json.dumps(next(item["run"] for item in items if item["run"]["id"] == run_id)))
elif args[:1] == ["api"] and "/actions/artifacts" in args[1]:
    print(json.dumps([{{"total_count": len(items), "artifacts": [item["artifact"] for item in items]}}]))
elif args[:2] == ["run", "download"]:
    name = args[args.index("--name") + 1]
    target = pathlib.Path(args[args.index("--dir") + 1])
    target.mkdir(parents=True, exist_ok=True)
    raw = next(item["raw"] for item in items if item["artifact"]["name"] == name)
    (target / "evidence.json").write_text(raw)
elif args[:2] == ["attestation", "verify"]:
    pass
else:
    raise SystemExit(9)
"""
        gh.write_text(script)
        gh.chmod(0o700)
        return str(bin_dir) + os.pathsep + os.environ.get("PATH", "")

    def install_cli_with_fake_provider(self, directory):
        root = pathlib.Path(directory)
        copied_cli = root / "evidence_ledger.py"
        shutil.copyfile(CLI, copied_cli)
        provider = root / "coolify_client.py"
        provider.write_text(textwrap.dedent(f"""
            class AccessPolicy:
                @classmethod
                def from_environment(cls, purpose, environment, prefix=None):
                    if purpose != "verify":
                        raise ValueError("wrong purpose")
                    return cls()

            class CoolifyClient:
                def __init__(self, base_url, token, policy):
                    if not base_url.startswith("https://") or not token:
                        raise ValueError("missing provider context")

                @staticmethod
                def literal_path(*segments):
                    return "/" + "/".join(segments)

                def request(self, method, path, body=None):
                    if path == "/applications/app-production":
                        return {{"uuid": "app-production", "git_commit_sha": {TARGET_SHA!r}, "is_auto_deploy_enabled": False}}
                    if path == "/deployments/deployment-0":
                        return {{"deployment_uuid": "deployment-0", "resource_uuid": "app-production", "commit": {TARGET_SHA!r}, "status": "finished"}}
                    if path == "/deployments":
                        return []
                    raise ValueError("unexpected provider path")

            def probe_https_health(url, **kwargs):
                if url != {HEALTH_URL!r}:
                    raise ValueError("wrong health URL")
        """))
        return copied_cli

    def install_fake_deploy_helper(self, directory, *, fail=False):
        helper = pathlib.Path(directory) / "deploy_exact_revision.py"
        helper.write_text(textwrap.dedent(f"""\
            import argparse, hashlib, json, pathlib, sys
            parser = argparse.ArgumentParser()
            parser.add_argument("--resource-uuid", required=True)
            parser.add_argument("--revision", required=True)
            parser.add_argument("--health-url", required=True)
            parser.add_argument("--lock-dir", required=True)
            parser.add_argument("--rollback-evidence", required=True)
            parser.add_argument("--record-output", required=True)
            args = parser.parse_args()
            if {fail!r}:
                print("TOP_SECRET=must-not-escape", file=sys.stderr)
                raise SystemExit(2)
            record = {{
                "schemaVersion": 1,
                "recordType": "coolify-exact-deployment",
                "writer": "project-harness/deploy_exact_revision.py",
                "resourceUuid": args.resource_uuid,
                "revision": args.revision,
                "deploymentUuid": "deployment-restored",
                "healthUrlSha256": hashlib.sha256(args.health_url.encode()).hexdigest(),
                "healthVerified": True,
                "outcome": "deployment-succeeded",
            }}
            pathlib.Path(args.record_output).write_text(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\\n")
        """))
        return helper

    def test_help_lists_every_workflow_command(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for command in COMMANDS:
            self.assertIn(command, result.stdout)
            command_help = self.run_cli(command, "--help")
            self.assertEqual(command_help.returncode, 0, command_help.stderr)

    def test_backend_receipt_and_initial_aggregate_are_canonical(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            receipt_dir = root / "receipts"
            receipt_dir.mkdir()
            receipt_path = receipt_dir / "postgres.json"
            result = self.run_cli(
                "backend-receipt",
                "--capability", "postgres",
                "--resource-ref", "postgres-production",
                "--previous-revision", TARGET_SHA,
                "--backup-ref", "backup-42",
                "--receipt-sha256", "2" * 64,
                "--output", receipt_path,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(receipt_path.read_bytes())
            self.assertEqual(receipt["capabilityId"], "postgres")
            self.assertEqual(receipt_path.read_bytes(), canonical(receipt))

            aggregate_path = root / "backend.json"
            path = self.install_fake_gh(root, empty_list=True)
            result = self.run_cli(
                "aggregate-backend",
                "--receipts", receipt_dir,
                "--release-revision", NEXT_SHA,
                "--expected-capability", "postgres",
                "--schema", "backend-release-v1",
                "--output", aggregate_path,
                env={**github_environment(workflow=".github/workflows/backend-prepare.yml"), "PATH": path},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            aggregate = json.loads(aggregate_path.read_bytes())
            self.assertEqual(aggregate["sequence"], 0)
            self.assertIsNone(aggregate["predecessor"])
            self.assertEqual(aggregate_path.read_bytes(), canonical(aggregate))

            verified = self.run_cli(
                "verify-backend-capability",
                "--evidence", aggregate_path,
                "--capability", "postgres",
                "--revision", NEXT_SHA,
            )
            self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_successor_and_rollback_revision_use_verified_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            previous = deployment()
            envelope = {"locator": locator(previous), "record": previous}
            envelope_path = root / "previous.json"
            deploy_path = root / "deploy.json"
            output_path = root / "evidence.json"
            self.write_json(envelope_path, envelope)
            self.write_json(deploy_path, deploy_record(revision=NEXT_SHA, deployment_uuid="deployment-1"))
            result = self.run_cli(
                "successor",
                "--lane", "production",
                "--predecessor", envelope_path,
                "--deploy-record", deploy_path,
                "--target-revision", NEXT_SHA,
                "--output", output_path,
                env=github_environment(),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            successor = json.loads(output_path.read_bytes())
            self.assertEqual(successor["predecessor"], envelope["locator"])
            self.assertEqual(successor["sequence"], 1)
            self.assertEqual(successor["revision"], NEXT_SHA)

            rollback = self.run_cli("derive-rollback", "--evidence", envelope_path)
            self.assertEqual(rollback.returncode, 0, rollback.stderr)
            self.assertEqual(rollback.stdout, f"revision={TARGET_SHA}\n")

    def test_resolve_locator_verifies_artifact_digest_attestation_and_producer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            record = deployment()
            path = self.install_fake_gh(root, record=record)
            output = root / "resolved.json"
            result = self.run_cli(
                "resolve-locator",
                "--schema", "deployment-success-v1",
                "--lane", "production",
                "--run-id", "41",
                "--artifact-id", "51",
                "--artifact-name", "deployment-production-41-1",
                "--historical",
                "--output", output,
                env={"GITHUB_REPOSITORY": REPOSITORY, "PATH": path},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            resolved = json.loads(output.read_bytes())
            self.assertEqual(resolved, {"locator": locator(record), "record": record})
            self.assertEqual(output.read_bytes(), canonical(resolved))

            bad_root = root / "bad"
            bad_root.mkdir()
            bad_path = self.install_fake_gh(bad_root, record=record, fail_attestation=True)
            failed = self.run_cli(
                "resolve-locator",
                "--schema", "deployment-success-v1",
                "--lane", "production",
                "--run-id", "41",
                "--artifact-id", "51",
                "--artifact-name", "deployment-production-41-1",
                "--historical",
                "--output", root / "must-not-exist.json",
                env={"GITHUB_REPOSITORY": REPOSITORY, "PATH": bad_path, "TOP_SECRET": "do-not-echo"},
            )
            self.assertEqual(failed.returncode, 2)
            self.assertIn("attestation", failed.stderr.lower())
            self.assertNotIn("do-not-echo", failed.stderr)

    def test_resolve_unique_live_head_and_emit_local_deploy_record(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.install_cli_with_fake_provider(directory)
            root = pathlib.Path(directory)
            record = deployment()
            path = self.install_fake_gh(root, record=record)
            envelope_path = root / "head.json"
            deploy_path = root / "current.json"
            result = self.run_cli(
                "resolve-stage-head",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--output", envelope_path,
                "--deploy-record-output", deploy_path,
                env={
                    "PATH": path,
                    "COOLIFY_URL": "https://coolify.example.test",
                    "COOLIFY_VERIFY_TOKEN": "opaque-token",
                    "COOLIFY_VERIFY_TOKEN_SCOPES": "read",
                    "COOLIFY_VERIFY_TOKEN_EXPIRES_AT": "2099-01-01T00:00:00Z",
                    "COOLIFY_VERIFY_TOKEN_IP_ALLOWLISTED": "true",
                },
                cli=cli,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(envelope_path.read_bytes())["record"], record)
            local = json.loads(deploy_path.read_bytes())
            self.assertEqual(local["revision"], TARGET_SHA)
            self.assertEqual(local["writer"], "project-harness/deploy_exact_revision.py")

    def test_create_retention_checkpoint_reroots_the_live_current_head(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.install_cli_with_fake_provider(directory)
            root = pathlib.Path(directory)
            record = deployment()
            path = self.install_fake_gh(root, record=record)
            output = root / "checkpoint.json"
            result = self.run_cli(
                "create-retention-checkpoint",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--output", output,
                env={
                    **github_environment(
                        workflow=".github/workflows/evidence-retention-checkpoint.yml",
                        run_id=91,
                    ),
                    "PATH": path,
                    "COOLIFY_URL": "https://coolify.example.test",
                    "COOLIFY_VERIFY_TOKEN": "opaque-token",
                    "COOLIFY_VERIFY_TOKEN_SCOPES": "read",
                    "COOLIFY_VERIFY_TOKEN_EXPIRES_AT": "2099-01-01T00:00:00Z",
                    "COOLIFY_VERIFY_TOKEN_IP_ALLOWLISTED": "true",
                },
                cli=cli,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            checkpoint = json.loads(output.read_bytes())
            self.assertEqual(checkpoint["schema"], "retention-checkpoint-v1")
            self.assertEqual(checkpoint["epoch"], 1)
            self.assertEqual(checkpoint["supersededHeadSha256"], hashlib.sha256(canonical(record)).hexdigest())

    def test_delivery_scan_skips_expired_ancestry_but_direct_locator_refuses_it(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.install_cli_with_fake_provider(directory)
            root = pathlib.Path(directory)
            now = datetime.now(timezone.utc).replace(microsecond=0)
            genesis = deployment(run_id=40)
            genesis_locator = locator(
                genesis,
                run_id=40,
                artifact_id=50,
                artifact_name="deployment-production-40-1",
            )
            checkpoint_one = {
                "schema": "retention-checkpoint-v1",
                "repository": REPOSITORY,
                "lane": "production",
                "provider": "coolify",
                "resourceUuid": "app-production",
                "revision": TARGET_SHA,
                "deploymentUuid": "deployment-0",
                "healthUrlSha256": hashlib.sha256(HEALTH_URL.encode()).hexdigest(),
                "healthVerified": True,
                "autoDeployDisabled": True,
                "epoch": 1,
                "sequence": 0,
                "supersededHead": genesis_locator,
                "supersededHeadSha256": genesis_locator["sha256"],
                "createdAt": now.isoformat().replace("+00:00", "Z"),
                "expiresAt": (now + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                "target": {
                    "revision": TARGET_SHA,
                    "ciRunId": None,
                    "ciWorkflowPath": None,
                },
                "producer": producer(
                    run_id=41,
                    workflow=".github/workflows/evidence-retention-checkpoint.yml",
                ),
                "outcome": "retention-checkpointed",
            }
            checkpoint_one_locator = locator(
                checkpoint_one,
                run_id=41,
                artifact_id=51,
                artifact_name="retention-checkpoint-production-41-1",
            )
            checkpoint_two = {
                **checkpoint_one,
                "epoch": 2,
                "supersededHead": checkpoint_one_locator,
                "supersededHeadSha256": checkpoint_one_locator["sha256"],
                "producer": producer(
                    run_id=42,
                    workflow=".github/workflows/evidence-retention-checkpoint.yml",
                ),
            }
            path = self.install_fake_gh_inventory(root, [
                (50, 40, "deployment-production-40-1", genesis, True),
                (51, 41, "retention-checkpoint-production-41-1", checkpoint_one, True),
                (52, 42, "retention-checkpoint-production-42-1", checkpoint_two, False),
            ])
            output = root / "head.json"
            result = self.run_cli(
                "resolve-stage-head",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--output", output,
                "--deploy-record-output", root / "current.json",
                env={
                    "PATH": path,
                    "COOLIFY_URL": "https://coolify.example.test",
                    "COOLIFY_VERIFY_TOKEN": "opaque-token",
                    "COOLIFY_VERIFY_TOKEN_SCOPES": "read",
                    "COOLIFY_VERIFY_TOKEN_EXPIRES_AT": "2099-01-01T00:00:00Z",
                    "COOLIFY_VERIFY_TOKEN_IP_ALLOWLISTED": "true",
                },
                cli=cli,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(output.read_bytes())["record"]["epoch"], 2)
            expired = self.run_cli(
                "resolve-locator",
                "--schema", "delivery-head-v1",
                "--lane", "production",
                "--run-id", "41",
                "--artifact-id", "51",
                "--artifact-name", "retention-checkpoint-production-41-1",
                "--historical",
                "--output", root / "expired.json",
                env={"GITHUB_REPOSITORY": REPOSITORY, "PATH": path},
                cli=cli,
            )
            self.assertEqual(expired.returncode, 2)
            self.assertIn("expired", expired.stderr)

    def test_delivery_scan_ignores_failed_target_artifact_and_keeps_predecessor_head(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.install_cli_with_fake_provider(directory)
            root = pathlib.Path(directory)
            predecessor = deployment(run_id=41)
            predecessor_locator = locator(
                predecessor,
                run_id=41,
                artifact_id=51,
                artifact_name="deployment-production-41-1",
            )
            failed_target = deployment(
                sequence=1,
                revision=NEXT_SHA,
                predecessor=predecessor_locator,
                run_id=42,
                deployment_uuid="deployment-target",
            )
            path = self.install_fake_gh_inventory(root, [
                (51, 41, "deployment-production-41-1", predecessor, False),
                (52, 42, "deployment-production-42-1", failed_target, False, "failure"),
            ])
            output = root / "head.json"
            resolved = self.run_cli(
                "resolve-stage-head",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--output", output,
                "--deploy-record-output", root / "current.json",
                env={
                    "PATH": path,
                    "COOLIFY_URL": "https://coolify.example.test",
                    "COOLIFY_VERIFY_TOKEN": "opaque-token",
                    "COOLIFY_VERIFY_TOKEN_SCOPES": "read",
                    "COOLIFY_VERIFY_TOKEN_EXPIRES_AT": "2099-01-01T00:00:00Z",
                    "COOLIFY_VERIFY_TOKEN_IP_ALLOWLISTED": "true",
                },
                cli=cli,
            )
            self.assertEqual(resolved.returncode, 0, resolved.stderr)
            self.assertEqual(json.loads(output.read_bytes())["record"], predecessor)

            rejected = self.run_cli(
                "resolve-locator",
                "--schema", "deployment-success-v1",
                "--lane", "production",
                "--run-id", "42",
                "--artifact-id", "52",
                "--artifact-name", "deployment-production-42-1",
                "--historical",
                "--output", root / "rejected.json",
                env={"GITHUB_REPOSITORY": REPOSITORY, "PATH": path},
                cli=cli,
            )
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("successful main-sourced", rejected.stderr)

    def test_resolve_head_rejects_dangling_predecessor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            missing = locator(deployment(), run_id=40, artifact_id=50, artifact_name="deployment-production-40-1")
            child = deployment(sequence=1, revision=NEXT_SHA, predecessor=missing)
            path = self.install_fake_gh(root, record=child)
            result = self.run_cli(
                "resolve-stage-head",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--output", root / "must-not-exist.json",
                "--deploy-record-output", root / "must-not-exist-local.json",
                env={"PATH": path},
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("missing or superseded predecessor", result.stderr)

    def test_bootstrap_import_uses_live_provider_and_empty_is_non_authorizing(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.install_cli_with_fake_provider(directory)
            root = pathlib.Path(directory)
            path = self.install_fake_gh(root, empty_list=True)
            common = {
                **github_environment(workflow=".github/workflows/bootstrap-deployment-evidence.yml"),
                "LANE": "production",
                "RESOURCE_UUID": "app-production",
                "HEALTH_URL": HEALTH_URL,
                "COOLIFY_URL": "https://coolify.example.test",
                "COOLIFY_VERIFY_TOKEN": "opaque-token",
                "COOLIFY_VERIFY_TOKEN_SCOPES": "read",
                "COOLIFY_VERIFY_TOKEN_EXPIRES_AT": "2099-01-01T00:00:00Z",
                "COOLIFY_VERIFY_TOKEN_IP_ALLOWLISTED": "true",
                "PATH": path,
            }
            imported_path = root / "imported.json"
            result = self.run_cli(
                "bootstrap-import-existing", "--output", imported_path,
                env={**common, "EXPECTED_REVISION": TARGET_SHA, "EXISTING_DEPLOYMENT_UUID": "deployment-0"},
                cli=cli,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            imported = json.loads(imported_path.read_bytes())
            self.assertEqual(imported["schema"], "deployment-success-v1")
            self.assertEqual(imported["sequence"], 0)

            empty_path = root / "empty.json"
            empty_result = self.run_cli(
                "bootstrap-empty", "--schema", "empty-observation-v1", "--output", empty_path,
                env=common,
                cli=cli,
            )
            self.assertEqual(empty_result.returncode, 0, empty_result.stderr)
            empty = json.loads(empty_path.read_bytes())
            self.assertEqual(empty["schema"], "empty-observation-v1")
            rollback = self.run_cli("derive-rollback", "--evidence", empty_path, cli=cli)
            self.assertEqual(rollback.returncode, 2)
            self.assertIn("cannot authorize rollback", rollback.stderr)

    def test_consume_chains_and_rejects_mismatched_backend_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            deployment_record = deployment(revision=NEXT_SHA)
            deployment_envelope = {"locator": locator(deployment_record), "record": deployment_record}
            deployment_path = root / "deployment.json"
            self.write_json(deployment_path, deployment_envelope)
            backend = {
                "schema": "backend-release-v1",
                "repository": REPOSITORY,
                "lane": "production",
                "provider": "aggregate",
                "releaseRevision": NEXT_SHA,
                "capabilities": [{
                    "capabilityId": "postgres",
                    "kind": "coolify.postgresql",
                    "provider": "coolify-postgresql",
                    "resourceRef": "postgres-production",
                    "previousRevision": TARGET_SHA,
                    "backupRef": "backup-42",
                    "receiptSha256": "2" * 64,
                    "outcome": "prepared-expand-only",
                }],
                "sequence": 0,
                "predecessor": None,
                "producer": producer(run_id=61, workflow=".github/workflows/backend-prepare.yml"),
                "outcome": "backend-release-succeeded",
            }
            backend_envelope = {
                "locator": locator(backend, run_id=61, artifact_id=71, artifact_name="backend-release-61-1"),
                "record": backend,
            }
            backend_path = root / "backend.json"
            self.write_json(backend_path, backend_envelope)
            output = root / "consumption.json"
            path = self.install_fake_gh(root, empty_list=True)
            result = self.run_cli(
                "consume",
                "--deployment", deployment_path,
                "--backend", backend_path,
                "--application-revision", NEXT_SHA,
                "--resource-uuid", "app-production",
                "--output", output,
                env={**github_environment(), "PATH": path},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            consumption = json.loads(output.read_bytes())
            self.assertEqual(consumption["backendEvidence"], backend_envelope["locator"])
            self.assertEqual(consumption["sequence"], 0)

            failed = self.run_cli(
                "consume",
                "--deployment", deployment_path,
                "--backend", backend_path,
                "--application-revision", TARGET_SHA,
                "--resource-uuid", "app-production",
                "--output", root / "bad-consumption.json",
                env={**github_environment(), "PATH": path},
            )
            self.assertEqual(failed.returncode, 2)
            self.assertIn("deployment evidence revision", failed.stderr)

    def test_published_locator_binds_consumption_to_current_successor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            predecessor = deployment()
            predecessor_locator = locator(predecessor)
            successor = deployment(
                sequence=1,
                revision=NEXT_SHA,
                predecessor=predecessor_locator,
                run_id=91,
                deployment_uuid="deployment-1",
            )
            evidence_path = root / "successor.json"
            output_path = root / "published.json"
            self.write_json(evidence_path, successor)
            result = self.run_cli(
                "published-locator",
                "--evidence", evidence_path,
                "--artifact-id", "92",
                "--artifact-name", "deployment-production-91-1",
                "--output", output_path,
                env=github_environment(run_id=91),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            envelope = json.loads(output_path.read_bytes())
            self.assertEqual(envelope["record"], successor)
            self.assertEqual(envelope["locator"]["artifactId"], 92)
            self.assertEqual(envelope["locator"]["sha256"], hashlib.sha256(canonical(successor)).hexdigest())

    def test_assert_bootstrap_available_rejects_existing_deployment_genesis(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            record = deployment()
            path = self.install_fake_gh(root, record=record)
            result = self.run_cli(
                "assert-bootstrap-available",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--mode", "import-existing",
                env={"PATH": path},
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("existing deployment chain", result.stderr)

    def test_bootstrap_gate_ignores_other_resource_or_health_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            unrelated = {
                **deployment(resource_uuid="app-other"),
                "healthUrlSha256": hashlib.sha256(b"https://other.example.test/ready").hexdigest(),
            }
            path = self.install_fake_gh(root, record=unrelated)
            result = self.run_cli(
                "assert-bootstrap-available",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--mode", "import-existing",
                env={"PATH": path},
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_bootstrap_gate_allows_import_after_empty_but_rejects_second_empty_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            empty = {
                "schema": "empty-observation-v1",
                "repository": REPOSITORY,
                "lane": "production",
                "provider": "coolify",
                "resourceUuid": "app-production",
                "healthUrlSha256": hashlib.sha256(HEALTH_URL.encode()).hexdigest(),
                "sequence": 0,
                "producer": producer(
                    run_id=41,
                    workflow=".github/workflows/bootstrap-deployment-evidence.yml",
                ),
                "outcome": "empty-observed",
            }
            path = self.install_fake_gh(
                root,
                record=empty,
                artifact_name="bootstrap-production-41-1",
                workflow_path=".github/workflows/bootstrap-deployment-evidence.yml",
            )
            allowed = self.run_cli(
                "assert-bootstrap-available",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--mode", "import-existing",
                env={"PATH": path},
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            rejected = self.run_cli(
                "assert-bootstrap-available",
                "--repository", REPOSITORY,
                "--lane", "production",
                "--resource-uuid", "app-production",
                "--health-url", HEALTH_URL,
                "--mode", "initialize-empty",
                env={"PATH": path},
            )
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("empty observation already exists", rejected.stderr)

    def test_compensate_uses_verified_predecessor_and_withholds_helper_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            cli = root / "evidence_ledger.py"
            shutil.copyfile(CLI, cli)
            self.install_fake_deploy_helper(root)
            previous = deployment()
            envelope_path = root / "previous.json"
            current_path = root / "current.json"
            self.write_json(envelope_path, {"locator": locator(previous), "record": previous})
            self.write_json(current_path, deploy_record(revision=NEXT_SHA, deployment_uuid="deployment-1"))
            result = self.run_cli(
                "compensate",
                "--predecessor", envelope_path,
                "--deploy-record", current_path,
                "--health-url", HEALTH_URL,
                cli=cli,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(current_path.read_bytes())["revision"], TARGET_SHA)

            self.install_fake_deploy_helper(root, fail=True)
            self.write_json(current_path, deploy_record(revision=NEXT_SHA, deployment_uuid="deployment-2"))
            failed = self.run_cli(
                "compensate",
                "--predecessor", envelope_path,
                "--deploy-record", current_path,
                "--health-url", HEALTH_URL,
                env={"TOP_SECRET": "also-must-not-escape"},
                cli=cli,
            )
            self.assertEqual(failed.returncode, 2)
            self.assertIn("helper output withheld", failed.stderr)
            self.assertNotIn("must-not-escape", failed.stderr)

    def test_rejects_noncanonical_input_and_unknown_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "record.json"
            path.write_text(json.dumps(deployment(), indent=2))
            result = self.run_cli("validate", path)
            self.assertEqual(result.returncode, 2)
            self.assertIn("canonical", result.stderr)
            unknown = self.run_cli("backend-receipt", "--capability", "postgres", "--surprise", "yes")
            self.assertEqual(unknown.returncode, 2)


if __name__ == "__main__":
    unittest.main()
