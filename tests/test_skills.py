import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_inventory_metadata():
    observed = datetime.datetime.now(datetime.timezone.utc)
    return {
        "inventoryVersion": 1,
        "inventoryId": str(uuid.uuid4()),
        "source": "coolify-api",
        "observedAt": observed.isoformat(),
        "expiresAt": (observed + datetime.timedelta(minutes=10)).isoformat(),
    }


def fresh_access_policy(purpose="reconcile"):
    scopes = {
        "reconcile": ["read", "write"],
        "verify": ["read"],
        "pin": ["read", "write"],
        "deploy": ["read", "deploy"],
    }[purpose]
    return {
        "purpose": purpose,
        "scopes": scopes,
        "expiresAt": (
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
        ).isoformat(),
        "ipAllowlisted": True,
    }


def coolify_test_environment(base_url, purpose="reconcile"):
    policy = fresh_access_policy(purpose)
    return {
        **os.environ,
        "COOLIFY_URL": base_url,
        "COOLIFY_TOKEN": "test-token",
        "COOLIFY_TOKEN_SCOPES": ",".join(policy["scopes"]),
        "COOLIFY_TOKEN_EXPIRES_AT": policy["expiresAt"],
        "COOLIFY_TOKEN_IP_ALLOWLISTED": "true",
        "HARNESS_TEST_ALLOW_INSECURE_LOOPBACK": "1",
    }


def agent_inventory(issue):
    observed = datetime.datetime.now(datetime.timezone.utc)
    return {
        "inventoryVersion": 1,
        "inventoryId": str(uuid.uuid4()),
        "applicationUuid": issue["applicationUuid"],
        "serverUuid": issue["serverUuid"],
        "harnessImage": issue["harnessImage"],
        "opencodeWebImage": issue["opencodeWebImage"],
        "dataDir": issue["dataDir"],
        "replicas": 1,
        "rolloutHarnessImage": issue["harnessImage"],
        "rolloutOpenCodeWebImage": issue["opencodeWebImage"],
        "rolloutStatus": "running",
        "observedAt": observed.isoformat(),
        "expiresAt": (observed + datetime.timedelta(minutes=10)).isoformat(),
        "source": "coolify-api",
    }


def healthy_worker_contract():
    payload = json.loads((
        ROOT
        / "skills/deploy-issue-harness-agent/assets/contracts/worker-health-v1.healthy.json"
    ).read_text())
    payload["lastHeartbeatAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload["ageMs"] = 10
    return payload


def install_fake_attestation_materials(root):
    config_path = root / ".harness" / "config.json"
    payload = json.loads(config_path.read_text())
    issue = payload["issueAgent"]
    manifests = {
        "harness": b'{"kind":"oci-index","image":"harness"}\n',
        "opencode": b'{"kind":"oci-index","image":"opencode"}\n',
    }
    paths = {}
    results = {}
    for name, content in manifests.items():
        manifest = root / f"{name}-manifest.json"
        manifest.write_bytes(content)
        paths[f"{name}Manifest"] = manifest
        image_name = "issue-harness" if name == "harness" else "opencode-web"
        subject = (
            f"ghcr.io/void0dev/{image_name}@sha256:"
            + hashlib.sha256(content).hexdigest()
        )
        issue[f"{name}Image" if name == "harness" else "opencodeWebImage"] = subject
        bundle = root / f"{name}-attestation.jsonl"
        bundle.write_text("signed bundle fixture")
        paths[f"{name}Bundle"] = bundle
        source_ref = "refs/heads/main"
        results[name] = [{
            "verificationResult": {
                "statement": {
                    "subject": [{
                        "name": subject.rsplit("@sha256:", 1)[0],
                        "digest": {"sha256": subject.rsplit("@sha256:", 1)[1]},
                    }],
                },
                "signature": {"certificate": {
                    "sourceRepositoryURI": issue["imageSourceRepository"],
                    "sourceRepositoryDigest": issue["imageSourceCommit"],
                    "sourceRepositoryRef": source_ref,
                    "githubWorkflowRepository": "Void0dev/harness",
                    "githubWorkflowRef": source_ref,
                    "buildSignerURI": (
                        "https://github.com/Void0dev/harness/"
                        ".github/workflows/publish-images.yml@refs/heads/main"
                    ),
                    "runnerEnvironment": "github-hosted",
                    "runInvocationURI": (
                        "https://github.com/Void0dev/harness/actions/runs/"
                        f"{issue['imagePublicationRunId']}/attempts/1"
                    ),
                }},
            }
        }]
    config_path.write_text(json.dumps(payload))
    trusted_root = root / "trusted_root.jsonl"
    trusted_root.write_text("trusted root fixture")
    fake_bin = root / "fake-bin"
    fake_bin.mkdir()
    fake_gh = fake_bin / "gh"
    fake_gh.write_text(
        "#!/bin/sh\n"
        "IFS= read -r artifact < \"$3\"\n"
        f"case \"$artifact\" in\n"
        f"  *'\"image\":\"harness\"'*) printf '%s' {shlex.quote(json.dumps(results['harness']))} ;;\n"
        f"  *'\"image\":\"opencode\"'*) printf '%s' {shlex.quote(json.dumps(results['opencode']))} ;;\n"
        "  *) exit 2 ;;\n"
        "esac\n"
    )
    fake_gh.chmod(0o755)
    arguments = [
        "--harness-manifest", paths["harnessManifest"],
        "--opencode-web-manifest", paths["opencodeManifest"],
        "--harness-attestation-bundle", paths["harnessBundle"],
        "--opencode-web-attestation-bundle", paths["opencodeBundle"],
        "--trusted-root", trusted_root,
        "--source-ref", "refs/heads/main",
    ]
    return issue, arguments, fake_bin


def run_script(relative, *args, env=None):
    return subprocess.run(
        [sys.executable, str(ROOT / relative), *map(str, args)],
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
            "install": "echo install", "test": "true", "lint": "true", "typecheck": "true", "build": "true", "smoke": "true",
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
            "harnessImage": "ghcr.io/void0dev/issue-harness@sha256:" + "a" * 64,
            "opencodeWebImage": "ghcr.io/void0dev/opencode-web@sha256:" + "b" * 64,
            "imageSourceRepository": "https://github.com/Void0dev/harness",
            "imageSourceCommit": "c" * 40,
            "imagePublicationRunId": "123456789",
            "serverUuid": "automation-server", "dataDir": "/opt/issue-harness/acme-service",
            "maxConcurrentRuns": 1, "replicas": 1,
        },
    }


def hybrid_config_v2():
    module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_hybrid_fixture")
    payload = config()
    payload["project"]["stack"] = "hybrid"
    normalized = module.normalize_config(payload)
    convex = next(item for item in normalized["capabilities"] if item["kind"] == "convex.deployment")
    convex["bindings"]["stage"].update({
        "projectRef": "convex-project-stage",
        "resourceRef": "convex-deployment-stage",
        "deploymentType": "permanent",
    })
    convex["bindings"]["production"].update({
        "projectRef": "convex-project-production",
        "resourceRef": "convex-deployment-production",
        "deploymentType": "permanent",
    })
    return normalized


def compiled_workflows(stack):
    payload = config()
    payload["project"]["stack"] = stack
    module = load_module(
        "skills/setup-coolify-cicd/harness_config.py",
        f"harness_config_delivery_fixture_{stack}",
    )
    return module.compile_workflows(
        payload,
        ROOT / "skills" / "setup-coolify-cicd" / "assets",
    )


def delivery_workflow(stack):
    return compiled_workflows(stack)["coolify-deploy.yml"]


def ci_workflow(payload=None):
    payload = payload or config()
    module = load_module(
        "skills/setup-coolify-cicd/harness_config.py",
        "harness_config_ci_fixture",
    )
    return module.compile_workflows(
        payload,
        ROOT / "skills" / "setup-coolify-cicd" / "assets",
    )["ci.yml"]


class SkillScriptsTest(unittest.TestCase):
    def test_schema_v1_hybrid_alias_expands_to_composable_capabilities(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_v1")
        payload = config()
        payload["project"]["stack"] = "hybrid"

        normalized = module.normalize_config(payload)

        self.assertEqual(normalized["schemaVersion"], 2)
        self.assertNotIn("stack", normalized["project"])
        self.assertEqual(
            [item["kind"] for item in normalized["capabilities"]],
            ["coolify.application", "coolify.postgresql", "convex.deployment"],
        )
        postgres = next(item for item in normalized["capabilities"] if item["kind"] == "coolify.postgresql")
        convex = next(item for item in normalized["capabilities"] if item["kind"] == "convex.deployment")
        self.assertEqual(postgres["commands"]["deployProduction"], "echo migrate-production")
        self.assertEqual(convex["commands"]["deployProduction"], "echo convex-production")
        self.assertEqual(
            set(normalized["commands"]),
            {"install", "test", "lint", "typecheck", "build", "smoke"},
        )
        self.assertNotIn("stage", normalized["coolify"])
        self.assertNotIn("production", normalized["coolify"])

    def test_schema_v1_preserves_compatible_stricter_delivery_policy_idempotently(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "harness_config_v1_delivery_policy",
        )
        payload = config()
        payload["deliveryPolicy"] = {
            "production": {
                "githubEnvironment": "production",
                "manualDispatchOnly": True,
                "requiredReviewers": 3,
                "preventSelfReview": True,
            },
            "rollback": {
                "strategy": "redeploy-previous-verified-revision",
                "requiresProductionApproval": True,
                "recordPreviousRevision": True,
            },
        }

        migrated = module.normalize_config(payload)

        self.assertEqual(migrated["deliveryPolicy"], payload["deliveryPolicy"])
        self.assertEqual(module.normalize_config(migrated), migrated)

    def test_schema_v2_rejects_the_legacy_stack_switch(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_v2")
        payload = config()
        payload["schemaVersion"] = 2
        payload["capabilities"] = []
        with self.assertRaisesRegex(ValueError, "project.stack is only supported"):
            module.normalize_config(payload)

    def test_schema_version_rejects_boolean_and_float_aliases(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "harness_config_exact_schema_version",
        )
        for version in (True, 1.0, False, 2.0):
            with self.subTest(version=version), self.assertRaisesRegex(
                ValueError, "schemaVersion must be the integer 1 or 2"
            ):
                payload = config()
                payload["schemaVersion"] = version
                module.normalize_config(payload)

    def test_repository_structure_is_validated_by_the_canonical_contract(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "harness_config_repository_contract",
        )
        canonical = module.normalize_config(config())
        cases = (
            (lambda payload: payload["branches"].update({"stage": "develop"}), "branches.stage must be 'stage'"),
            (lambda payload: payload["runtime"].update({"port": True}), "runtime.port must be an integer"),
            (lambda payload: payload["deployment"].update({"sourceVisibility": "internal"}), "sourceVisibility"),
            (lambda payload: payload["project"].update({"github": "not-a-repository"}), "project.github"),
        )
        for mutate, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                payload = json.loads(json.dumps(canonical))
                mutate(payload)
                module.validate_repository_contract(payload)

    def test_schema_v2_canonical_example_is_a_composable_capability_graph(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_example_v2")
        payload = json.loads(
            (ROOT / "skills/setup-coolify-cicd/assets/config.example.json").read_text()
        )

        normalized = module.normalize_config(payload)

        self.assertEqual(normalized["schemaVersion"], 2)
        self.assertNotIn("stack", normalized["project"])
        self.assertEqual(normalized["deliveryPolicy"]["production"]["requiredReviewers"], 1)
        self.assertEqual(
            normalized["deliveryPolicy"]["rollback"]["strategy"],
            "redeploy-previous-verified-revision",
        )
        self.assertEqual(normalized["deployment"]["minimumCoolifyVersion"], "4.1.2")
        self.assertEqual(normalized["deployment"]["revisionStrategy"], "git-commit-sha")
        self.assertEqual(normalized["coolify"]["apiPolicy"]["redirects"], "deny")
        self.assertTrue(normalized["coolify"]["apiPolicy"]["splitPinAndDeployCredentials"])
        self.assertEqual(
            {item["kind"] for item in normalized["capabilities"]},
            {"coolify.application", "coolify.postgresql", "convex.deployment"},
        )
        for capability in normalized["capabilities"]:
            self.assertEqual(set(capability["bindings"]), {"stage", "production"})
            self.assertTrue(capability["workflow"]["stageGate"])
            self.assertTrue(capability["workflow"]["productionGate"])

    def test_standalone_schema_validator_is_byte_identical_and_rejects_malformed_v2(self):
        setup_path = ROOT / "skills/setup-coolify-cicd/harness_config.py"
        deploy_path = ROOT / "skills/deploy-issue-harness-agent/scripts/harness_config.py"
        self.assertEqual(setup_path.read_bytes(), deploy_path.read_bytes())
        setup = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "setup_complete_schema",
        )
        standalone = load_module(
            "skills/deploy-issue-harness-agent/scripts/harness_config.py",
            "standalone_complete_schema",
        )
        canonical = setup.normalize_config(config())
        cases = (
            lambda payload: payload.pop("capabilities"),
            lambda payload: payload.pop("deliveryPolicy"),
            lambda payload: payload["capabilities"][0]["bindings"].pop("production"),
            lambda payload: payload["capabilities"][0].pop("evidence"),
            lambda payload: payload["coolify"].pop("apiPolicy"),
        )
        for mutate in cases:
            with self.subTest(mutate=mutate):
                payload = json.loads(json.dumps(canonical))
                mutate(payload)
                with self.assertRaises(ValueError):
                    setup.normalize_config(payload)
                with self.assertRaises(ValueError):
                    standalone.normalize_config(payload)

    def test_central_contract_compiles_exact_ci_and_delivery_workflows(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "harness_config_workflow_compiler",
        )
        assets = ROOT / "skills" / "setup-coolify-cicd" / "assets"
        expected_jobs = {
            "nest-postgres": {"verify", "migration-stage", "migration-production", "deploy-stage", "deploy-production"},
            "convex": {"verify", "backend-stage", "backend-production", "deploy-stage", "deploy-production"},
            "hybrid": {"verify", "migration-stage", "migration-production", "backend-stage", "backend-production", "deploy-stage", "deploy-production"},
        }
        validator = load_module(
            "skills/setup-coolify-cicd/scripts/validate_workflow.py",
            "workflow_parser_for_compiler_contract",
        )
        for stack in ("nest-postgres", "convex", "hybrid"):
            with self.subTest(stack=stack):
                payload = config()
                payload["project"]["stack"] = stack
                compiled = module.compile_workflows(payload, assets)
                self.assertEqual(
                    set(compiled),
                    {
                        "ci.yml",
                        "coolify-deploy.yml",
                        "backend-prepare.yml",
                        "coolify-rollback.yml",
                        "bootstrap-deployment-evidence.yml",
                        "evidence-retention-checkpoint.yml",
                    },
                )
                self.assertEqual(
                    set(validator.parse_jobs(compiled["coolify-deploy.yml"])),
                    expected_jobs[stack],
                )
                self.assertNotIn("__HARNESS_", "".join(compiled.values()))
                ci_jobs = validator.parse_jobs(compiled["ci.yml"])
                self.assertEqual(
                    ci_jobs["verify"]["_scalar_runs"],
                    [payload["commands"][key] for key in ("install", "test", "lint", "typecheck", "build")],
                )
                self.assertIn("permissions:\n  contents: read", compiled["ci.yml"])
                self.assertIn("environment: stage", compiled["coolify-deploy.yml"])
                self.assertIn("environment: production", compiled["coolify-deploy.yml"])
                self.assertIn("environment: production", compiled["backend-prepare.yml"])
                self.assertIn("environment: production", compiled["coolify-rollback.yml"])
                self.assertNotIn("  push:", compiled["backend-prepare.yml"])
                self.assertNotIn("  push:", compiled["coolify-rollback.yml"])
                expected_permissions = (
                    "permissions:\n"
                    "  actions: read\n"
                    "  attestations: write\n"
                    "  contents: read\n"
                    "  id-token: write"
                )
                self.assertIn(expected_permissions, compiled["backend-prepare.yml"])
                self.assertIn(expected_permissions, compiled["coolify-rollback.yml"])

    def test_workflow_yaml_parser_fallback_stays_fail_closed(self):
        validator = load_module(
            "skills/setup-coolify-cicd/scripts/validate_workflow.py",
            "workflow_yaml_parser_fallback",
        )
        original_import = __import__

        def import_without_yaml(name, *args, **kwargs):
            if name == "yaml":
                raise ImportError("test excludes PyYAML")
            return original_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=import_without_yaml), mock.patch.object(
            validator.shutil, "which", return_value=None
        ):
            self.assertIn(
                "requires PyYAML or Ruby",
                validator.yaml_syntax_error("name: valid\n"),
            )

        rejected = subprocess.CompletedProcess(
            args=["ruby"], returncode=1, stdout="", stderr="syntax error\n"
        )
        with mock.patch("builtins.__import__", side_effect=import_without_yaml), mock.patch.object(
            validator.shutil, "which", return_value="/usr/bin/ruby"
        ), mock.patch.object(validator.subprocess, "run", return_value=rejected):
            self.assertEqual(
                validator.yaml_syntax_error("not: [valid"),
                "invalid workflow YAML: syntax error",
            )

    def test_workflow_compiler_yaml_encodes_commands_and_preserves_exact_semantics(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "harness_config_yaml_commands",
        )
        validator = load_module(
            "skills/setup-coolify-cicd/scripts/validate_workflow.py",
            "workflow_parser_yaml_commands",
        )
        payload = config()
        payload["commands"]["install"] = 'printf "install: # literal"'
        payload["commands"]["test"] = 'node -e "console.log(\'test: # literal\')"'
        payload["commands"]["migrateStage"] = 'printf "migration: # literal"'
        payload["commands"]["lint"] = "printf 'next-line:\u0085literal'"

        compiled = module.compile_workflows(
            payload,
            ROOT / "skills" / "setup-coolify-cicd" / "assets",
        )

        self.assertIsNone(validator.yaml_syntax_error(compiled["ci.yml"]))
        self.assertIsNone(validator.yaml_syntax_error(compiled["coolify-deploy.yml"]))
        self.assertNotIn("\u0085", compiled["ci.yml"])
        self.assertIn("\\u0085", compiled["ci.yml"])
        ci_jobs = validator.parse_jobs(compiled["ci.yml"])
        delivery_jobs = validator.parse_jobs(compiled["coolify-deploy.yml"])
        self.assertEqual(
            ci_jobs["verify"]["_scalar_runs"][:2],
            [payload["commands"]["install"], payload["commands"]["test"]],
        )
        self.assertEqual(
            delivery_jobs["migration-stage"]["_scalar_runs"],
            [payload["commands"]["install"], payload["commands"]["migrateStage"]],
        )
        invalid = config()
        invalid["commands"]["install"] = "npm ci\necho injected"
        with self.assertRaisesRegex(ValueError, "bounded single-line command"):
            module.compile_workflows(invalid)

    def test_harness_migration_cli_dry_run_is_non_mutating_then_writes_canonical_v2(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        config_path = root / ".harness" / "config.json"
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        ci_path = root / ".github" / "workflows" / "ci.yml"
        backend_prepare_path = root / ".github" / "workflows" / "backend-prepare.yml"
        rollback_path = root / ".github" / "workflows" / "coolify-rollback.yml"
        checkpoint_path = root / ".github" / "workflows" / "evidence-retention-checkpoint.yml"
        before = {
            config_path: config_path.read_bytes(),
            workflow_path: workflow_path.read_bytes(),
            ci_path: ci_path.read_bytes(),
        }

        dry_run = run_script(
            "skills/setup-coolify-cicd/scripts/migrate_harness.py",
            root,
            "--dry-run",
        )

        self.assertEqual(dry_run.returncode, 0, dry_run.stderr + dry_run.stdout)
        report = json.loads(dry_run.stdout)
        self.assertTrue(report["dryRun"])
        self.assertEqual(report["sourceSchemaVersion"], 1)
        self.assertEqual(report["targetSchemaVersion"], 2)
        self.assertEqual(
            {item["path"] for item in report["files"]},
            {
                ".harness/config.json",
                ".github/workflows/ci.yml",
                ".github/workflows/coolify-deploy.yml",
                ".github/workflows/backend-prepare.yml",
                ".github/workflows/coolify-rollback.yml",
                ".github/workflows/bootstrap-deployment-evidence.yml",
                ".github/workflows/evidence-retention-checkpoint.yml",
                ".harness/evidence_ledger.py",
            },
        )
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

        written = run_script(
            "skills/setup-coolify-cicd/scripts/migrate_harness.py",
            root,
            "--write",
        )
        self.assertEqual(written.returncode, 0, written.stderr + written.stdout)
        self.assertFalse(json.loads(written.stdout)["dryRun"])
        canonical = json.loads(config_path.read_text())
        self.assertEqual(canonical["schemaVersion"], 2)
        self.assertNotIn("stack", canonical["project"])
        module = load_module(
            "skills/setup-coolify-cicd/harness_config.py",
            "harness_config_written_workflows",
        )
        compiled = module.compile_workflows(
            canonical,
            ROOT / "skills" / "setup-coolify-cicd" / "assets",
        )
        self.assertEqual(ci_path.read_text(), compiled["ci.yml"])
        self.assertEqual(workflow_path.read_text(), compiled["coolify-deploy.yml"])
        self.assertEqual(backend_prepare_path.read_text(), compiled["backend-prepare.yml"])
        self.assertEqual(rollback_path.read_text(), compiled["coolify-rollback.yml"])
        self.assertEqual(checkpoint_path.read_text(), compiled["evidence-retention-checkpoint.yml"])
        self.assertEqual(
            (root / ".harness" / "evidence_ledger.py").read_bytes(),
            (ROOT / "skills/setup-coolify-cicd/evidence_ledger.py").read_bytes(),
        )

    def test_harness_migration_uses_unique_temps_and_refuses_symlink_destinations(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        stale = root / ".harness" / "config.json.harness-migrate.tmp"
        stale.write_text("operator-owned-stale-file")
        written = run_script(
            "skills/setup-coolify-cicd/scripts/migrate_harness.py",
            root,
            "--write",
        )
        self.assertEqual(written.returncode, 0, written.stderr + written.stdout)
        self.assertEqual(stale.read_text(), "operator-owned-stale-file")

        outside = root / "outside-ci.yml"
        outside.write_text("do-not-touch")
        ci_path = root / ".github" / "workflows" / "ci.yml"
        ci_path.unlink()
        ci_path.symlink_to(outside)
        refused = run_script(
            "skills/setup-coolify-cicd/scripts/migrate_harness.py",
            root,
            "--write",
        )
        self.assertEqual(refused.returncode, 2, refused.stderr + refused.stdout)
        self.assertIn("contains a symlink", refused.stderr)
        self.assertEqual(outside.read_text(), "do-not-touch")

    def test_harness_writers_reject_symlinked_parent_components(self):
        for parent in (".harness", ".github", ".github/workflows"):
            with self.subTest(parent=parent):
                temporary, root = self.fixture()
                self.addCleanup(temporary.cleanup)
                target = root / parent
                outside = root / ("outside-" + parent.replace("/", "-").replace(".", ""))
                target.rename(outside)
                target.symlink_to(outside, target_is_directory=True)
                before = {
                    path: path.read_bytes()
                    for path in outside.rglob("*")
                    if path.is_file()
                }

                result = run_script(
                    "skills/setup-coolify-cicd/scripts/migrate_harness.py",
                    root,
                    "--write",
                )

                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertIn("symlink", result.stderr.lower())
                self.assertEqual(
                    {path: path.read_bytes() for path in before},
                    before,
                )

    def test_atomic_writer_rolls_back_replace_and_fsync_boundary_failures(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_io.py",
            "harness_io_failure_boundaries",
        )
        for boundary in ("replace", "fsync"):
            with self.subTest(boundary=boundary):
                temporary, root = self.fixture()
                self.addCleanup(temporary.cleanup)
                first = root / ".github" / "workflows" / "ci.yml"
                second = root / ".github" / "workflows" / "coolify-deploy.yml"
                originals = {first: first.read_bytes(), second: second.read_bytes()}
                if boundary == "replace":
                    original_replace = module.os.replace
                    calls = 0

                    def fail_second_replace(*args, **kwargs):
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            raise OSError("injected replace failure")
                        return original_replace(*args, **kwargs)

                    patcher = mock.patch.object(module.os, "replace", fail_second_replace)
                else:
                    original_fsync = module._fsync_directory
                    calls = 0

                    def fail_first_fsync(*args, **kwargs):
                        nonlocal calls
                        calls += 1
                        if calls == 1:
                            raise OSError("injected fsync failure")
                        return original_fsync(*args, **kwargs)

                    patcher = mock.patch.object(module, "_fsync_directory", fail_first_fsync)
                with patcher, self.assertRaisesRegex(OSError, "injected"):
                    module.atomic_write_files(root, {first: b"new-ci", second: b"new-deploy"})
                self.assertEqual({path: path.read_bytes() for path in originals}, originals)

    def test_config_cas_rejects_stale_reconcile_snapshot(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_io.py",
            "harness_io_config_cas",
        )
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        config_path = root / ".harness" / "config.json"
        snapshot = module.read_repository_file(root, config_path)
        expected = hashlib.sha256(snapshot).hexdigest()
        concurrent = json.loads(snapshot)
        concurrent["concurrentOperatorMarker"] = "preserve-me"
        config_path.write_text(json.dumps(concurrent))

        with module.repository_write_lock(root), self.assertRaisesRegex(
            RuntimeError, "changed since reconciliation started"
        ):
            module.write_config_cas_locked(root, config(), expected)

        self.assertEqual(json.loads(config_path.read_text())["concurrentOperatorMarker"], "preserve-me")

    def test_reconcile_apply_uses_the_locked_config_snapshot_cas(self):
        io_module = load_module(
            "skills/setup-coolify-cicd/harness_io.py",
            "harness_io_reconcile_cas",
        )
        reconcile = load_module(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            "coolify_reconcile_config_cas",
        )
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        config_path = root / ".harness" / "config.json"
        snapshot = io_module.read_repository_file(root, config_path)
        expected = hashlib.sha256(snapshot).hexdigest()
        normalized = reconcile.normalize_config(json.loads(snapshot))
        items = reconcile.desired(normalized)
        concurrent = json.loads(snapshot)
        concurrent["concurrentOperatorMarker"] = "preserve-me"
        config_path.write_text(json.dumps(concurrent))

        prepared = {item["lane"]: {} for item in items}
        with (
            io_module.repository_write_lock(root),
            mock.patch.object(reconcile, "preflight_applications", return_value=prepared),
            mock.patch.object(reconcile, "preflight_existing_environment_values"),
            mock.patch.object(reconcile, "ensure_environments"),
            mock.patch.object(reconcile, "drift", return_value={}),
            self.assertRaisesRegex(RuntimeError, "changed since reconciliation started"),
        ):
            reconcile.apply(
                config_path,
                normalized,
                object(),
                items,
                [],
                {"stage": {}, "production": {}},
                [],
                expected,
            )

        self.assertEqual(json.loads(config_path.read_text())["concurrentOperatorMarker"], "preserve-me")

    def test_dirfd_writer_fails_closed_when_parent_is_swapped_after_open(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_io.py",
            "harness_io_parent_swap",
        )
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        destination = root / ".github" / "workflows" / "ci.yml"
        original = destination.read_bytes()
        moved = root / "moved-workflows"
        attacker = root / "attacker-workflows"
        attacker.mkdir()
        original_identity_check = module._assert_parent_identity
        calls = 0

        def swap_before_replace(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                destination.parent.rename(moved)
                destination.parent.symlink_to(attacker, target_is_directory=True)
            return original_identity_check(*args, **kwargs)

        with mock.patch.object(module, "_assert_parent_identity", swap_before_replace):
            with self.assertRaisesRegex(ValueError, "parent.*changed|symlink"):
                module.atomic_write_files(root, {destination: b"attacker-controlled"})

        self.assertEqual((moved / "ci.yml").read_bytes(), original)
        self.assertEqual(list(attacker.iterdir()), [])

    def test_dirfd_writer_fails_closed_without_required_posix_primitives(self):
        module = load_module(
            "skills/setup-coolify-cicd/harness_io.py",
            "harness_io_unsupported_platform",
        )
        with mock.patch.object(module.os, "name", "nt"), self.assertRaisesRegex(
            RuntimeError, "POSIX dir_fd"
        ):
            module._require_secure_dirfd_support()

    def test_deploy_skill_verifiers_run_from_a_standalone_packaged_copy(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        package_root = root / "standalone-deploy-skill"
        shutil.copytree(ROOT / "skills" / "deploy-issue-harness-agent", package_root)
        agent = subprocess.run(
            [sys.executable, str(package_root / "scripts" / "verify_agent.py"), str(root), "--offline"],
            text=True,
            capture_output=True,
            cwd=root,
            env={**os.environ, "PYTHONPATH": ""},
        )
        diagnostics = subprocess.run(
            [sys.executable, str(package_root / "scripts" / "verify_diagnostics.py"), "--help"],
            text=True,
            capture_output=True,
            cwd=root,
            env={**os.environ, "PYTHONPATH": ""},
        )

        self.assertEqual(agent.returncode, 0, agent.stderr + agent.stdout)
        self.assertEqual(diagnostics.returncode, 0, diagnostics.stderr + diagnostics.stdout)
        self.assertNotIn("setup-coolify-cicd", agent.stderr + diagnostics.stderr)
        self.assertEqual(
            (ROOT / "skills/setup-coolify-cicd/harness_repository_contract.py").read_bytes(),
            (package_root / "scripts/harness_repository_contract.py").read_bytes(),
        )

    def test_typed_agent_evidence_contract_is_owned_by_the_standalone_agent_verifier(self):
        verifier = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "agent_typed_evidence",
        )
        contract = verifier.AGENT_INVENTORY_CONTRACT
        issue = config()["issueAgent"]
        evidence = agent_inventory(issue)

        self.assertEqual(contract.fields, verifier.INVENTORY_FIELDS)
        self.assertEqual(contract.validate(evidence), [])
        for version in (True, 1.0):
            with self.subTest(version=version):
                invalid_version = json.loads(json.dumps(evidence))
                invalid_version["inventoryVersion"] = version
                self.assertTrue(any(
                    "inventoryVersion must be 1" in error
                    for error in contract.validate(invalid_version)
                ))
        wrong_type = json.loads(json.dumps(evidence))
        wrong_type["replicas"] = True
        type_errors = contract.validate(wrong_type)
        self.assertTrue(any("replicas must be int" in error for error in type_errors))
        for mutate in (
            lambda payload: payload.update({"source": "coolify-ui"}),
            lambda payload: payload.update({"expiresAt": "2000-01-01T00:00:00+00:00"}),
            lambda payload: payload.update({"opencodeWebProvenanceVerified": True}),
        ):
            with self.subTest(mutate=mutate):
                candidate = json.loads(json.dumps(agent_inventory(issue)))
                mutate(candidate)
                self.assertEqual(
                    contract.validate(candidate),
                    verifier.AGENT_INVENTORY_CONTRACT.validate(candidate),
                )
        evidence["unreviewedField"] = "must-fail-closed"
        self.assertTrue(
            any(
                "unsupported fields" in error
                for error in contract.validate(evidence)
            )
        )
        self.assertTrue(
            any("unsupported fields" in error for error in verifier.verify_inventory(evidence, {}))
        )

    def test_all_repository_verifiers_reject_configs_outside_the_canonical_loader(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["schemaVersion"] = 3
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        commands = (
            (
                "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
                (root, "--offline"),
            ),
            (
                "skills/deploy-issue-harness-agent/scripts/verify_diagnostics.py",
                (
                    root,
                    "--allowed-origin", "https://diagnostics.example.test",
                    "--health-url", "https://diagnostics.example.test/health",
                    "--query-url", "https://diagnostics.example.test/query",
                    "--policy-check-url", "https://diagnostics.example.test/policy",
                    "--credential-env", "UNSET_DIAGNOSTIC_TOKEN",
                ),
            ),
        )
        for script, arguments in commands:
            with self.subTest(script=script):
                result = run_script(script, *arguments)
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertIn("schemaVersion must be the integer 1 or 2", result.stderr)

    def test_stateful_capabilities_own_application_and_workflow_credentials(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_credential_owners")
        payload = json.loads(
            (ROOT / "skills/setup-coolify-cicd/assets/config.example.json").read_text()
        )
        normalized = module.normalize_config(payload)
        application = next(
            item for item in normalized["capabilities"] if item["kind"] == "coolify.application"
        )
        postgres = next(
            item for item in normalized["capabilities"] if item["kind"] == "coolify.postgresql"
        )
        convex = next(
            item for item in normalized["capabilities"] if item["kind"] == "convex.deployment"
        )

        self.assertEqual(application["bindings"]["stage"]["environmentVariableRefs"], {})
        self.assertEqual(postgres["bindings"]["stage"]["applicationVariable"], "DATABASE_URL")
        self.assertEqual(postgres["bindings"]["stage"]["workflowSecretName"], "DATABASE_URL")
        self.assertEqual(convex["bindings"]["stage"]["workflowSecretName"], "CONVEX_DEPLOY_KEY")
        self.assertEqual(
            module.application_environment_refs(normalized, "stage"),
            {"DATABASE_URL": "STAGE_DATABASE_URL"},
        )

    def test_schema_v2_rejects_incomplete_known_capability_contracts(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_contract_v2")
        raw = (ROOT / "skills/setup-coolify-cicd/assets/config.example.json").read_text()
        cases = (
            (lambda capability: capability["commands"].pop("deployProduction"), "convex commands must define"),
            (lambda capability: capability["workflow"].update({"stageGate": None}), "workflow must define literal"),
            (lambda capability: capability["bindings"]["stage"].pop("deployKeyRef"), "deployKeyRef must be"),
        )
        for mutate, message in cases:
            with self.subTest(message=message):
                payload = json.loads(raw)
                convex = next(
                    item for item in payload["capabilities"] if item["kind"] == "convex.deployment"
                )
                mutate(convex)
                with self.assertRaisesRegex(ValueError, message):
                    module.normalize_config(payload)

    def test_schema_v2_rejects_shared_convex_projects_deployments_and_keys(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_convex_isolation")
        base = hybrid_config_v2()
        cases = (
            ("projectRef", "Convex stage and production projectRef values must be distinct"),
            ("resourceRef", "Convex stage and production resourceRef values must be distinct"),
            ("deployKeyRef", "Convex stage and production deployKeyRef values must be distinct"),
        )
        for key, message in cases:
            with self.subTest(key=key):
                payload = json.loads(json.dumps(base))
                convex = next(
                    item for item in payload["capabilities"] if item["kind"] == "convex.deployment"
                )
                convex["bindings"]["production"][key] = convex["bindings"]["stage"][key]
                with self.assertRaisesRegex(ValueError, message):
                    module.normalize_config(payload)

    def test_schema_v2_rejects_shared_application_resources_domains_and_lane_credentials(self):
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_lane_isolation")
        base = hybrid_config_v2()
        application = next(
            item for item in base["capabilities"] if item["kind"] == "coolify.application"
        )
        application["bindings"]["stage"].update({
            "resourceRef": "app-stage", "domain": "https://stage.example.test",
        })
        application["bindings"]["production"].update({
            "resourceRef": "app-production", "domain": "https://example.test",
        })
        cases = (
            ("resourceRef", "Application stage and production resourceRef values must be distinct"),
            ("domain", "Application stage and production domain values must be distinct"),
        )
        for key, message in cases:
            with self.subTest(key=key):
                payload = json.loads(json.dumps(base))
                app = next(
                    item for item in payload["capabilities"] if item["kind"] == "coolify.application"
                )
                app["bindings"]["production"][key] = app["bindings"]["stage"][key]
                with self.assertRaisesRegex(ValueError, message):
                    module.normalize_config(payload)

    def test_repository_exposes_the_three_installable_harness_skills(self):
        skill_names = sorted(
            path.name for path in (ROOT / "skills").iterdir()
            if path.is_dir() and (path / "SKILL.md").is_file()
        )
        self.assertEqual(skill_names, [
            "deploy-issue-harness-agent",
            "deploy-opencode-harness",
            "setup-coolify-cicd",
        ])

        project_skill = ROOT / "skills" / "setup-coolify-cicd"
        for relative in (
            "harness_config.py",
            "harness_evidence.py",
            "harness_io.py",
            "harness_repository_contract.py",
            "workflow_compiler.py",
            "evidence_ledger.py",
            "scripts/doctor.py",
            "scripts/coolify_reconcile.py",
            "scripts/migrate_harness.py",
            "scripts/validate_workflow.py",
            "assets/config.example.json",
            "assets/ci.yml",
            "assets/coolify-deploy.yml",
            "assets/backend-prepare.yml",
            "assets/backend-prepare-postgres.yml",
            "assets/backend-prepare-convex.yml",
            "assets/coolify-rollback.yml",
            "assets/bootstrap-deployment-evidence.yml",
            "assets/evidence-retention-checkpoint.yml",
            "assets/coolify_client.py",
            "assets/deploy_exact_revision.py",
        ):
            self.assertTrue((project_skill / relative).is_file(), relative)

        harness_skill = ROOT / "skills" / "deploy-issue-harness-agent"
        for relative in (
            "scripts/agent_evidence_contract.py",
            "scripts/harness_repository_contract.py",
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
        self.assertIn("ghcr.io/void0dev/opencode-web@sha256:", release_contract)

        addon_skill = ROOT / "skills" / "deploy-opencode-harness"
        self.assertTrue((addon_skill / "SKILL.md").is_file())

    def test_installation_skills_use_opencode_and_bind_existing_target_resources(self):
        setup = (ROOT / "skills/setup-coolify-cicd/SKILL.md").read_text()
        agent = (ROOT / "skills/deploy-issue-harness-agent/SKILL.md").read_text()
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()

        self.assertIn("Never create `stage` or `main`", setup)
        self.assertIn("Never create or deploy the target Coolify application", setup)
        self.assertNotIn("Create `stage` from `main`", setup)
        self.assertNotIn("Create or bind separate Coolify", setup)

        for document in (agent, addon):
            self.assertIn("OpenCode Web", document)
            self.assertNotIn("OPENCODE_AUTH_MODE=broker", document)
            self.assertNotIn("SANDBOX_NETWORK", document)
            self.assertNotIn("CODEX_", document)
        self.assertRegex(addon, r"Issue .+ session .+ branch .+ PR")

    def test_addon_skill_uses_one_time_profile_and_never_requests_pem_contents(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()
        profile = (ROOT / "skills/deploy-opencode-harness/references/developer-profile.md").read_text()
        self.assertIn("coolify_environment_url", addon)
        self.assertNotIn("coolify_production_url", addon)
        self.assertIn("local path to the downloaded private-key .pem file", addon)
        self.assertIn("Never ask the user to paste PEM contents", addon)
        self.assertIn("GITHUB_APP_INSTALLATION_ID", addon)
        self.assertIn("per-project GitHub App", addon)
        self.assertIn("Never ask the user for model URL, model ID, or model key", profile)

    def test_addon_skill_derives_the_only_app_repository_and_uses_coolify_generated_domain(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()
        profile = (ROOT / "skills/deploy-opencode-harness/references/developer-profile.md").read_text()
        for field in (
            "coolify_environment_url",
            "coolify_token_env_path",
            "github_app_id",
            "pem_path",
            "chat_login",
            "chat_password",
        ):
            self.assertIn(field, addon)
        self.assertIn("Generate Domain", addon)
        self.assertIn("Coolify-generated HTTPS URL", addon)
        self.assertIn("exactly one repository", addon)
        self.assertNotIn("repo_url:", addon)
        self.assertIn("Do not request approval while collecting these six values", addon)

    def test_addon_skill_selects_coolify_server_and_destination_without_reading_target_resources(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()
        profile = (ROOT / "skills/deploy-opencode-harness/references/developer-profile.md").read_text()
        self.assertIn("GET /api/v1/servers", addon)
        self.assertIn("GET /api/v1/servers/{server_uuid}/destinations", addon)
        self.assertIn("If exactly one usable server", addon)
        self.assertIn("If exactly one destination", addon)
        self.assertIn("Never call the environment-details endpoint", addon)
        self.assertNotIn("derive its HTTPS API origin and Project/environment identifiers", addon)
        self.assertNotIn("wildcard DNS", addon)
        self.assertNotIn("*.harness.example.com", profile)
        self.assertNotIn("h-<repository>-<hash8>.<base-domain>", profile)
        self.assertNotIn("chat_domain:", addon)

    def test_addon_skill_keeps_coolify_api_access_in_a_local_operator_profile(self):
        profile = (ROOT / "skills/deploy-opencode-harness/references/developer-profile.md").read_text()
        self.assertIn("COOLIFY_TOKEN", profile)
        self.assertIn("read, write, and deploy", profile)
        self.assertIn("Never paste the token into chat", profile)
        self.assertNotIn("COOLIFY_URL=", profile)

    def test_addon_skill_requires_per_action_approval_and_only_touches_harness_resources(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()
        self.assertIn("Before every read or write", addon)
        self.assertIn("approve <number>", addon)
        self.assertIn("Never call DELETE", addon)
        self.assertIn("Never read, modify, deploy, restart, or inspect target application resources", addon)
        self.assertIn("created in this installation", addon)

    def test_harness_runtime_uses_only_github_app_credentials(self):
        runtime_files = [
            ROOT / ".env.example",
            ROOT / "docker-compose.local.yml",
            ROOT / "coolify/docker-compose.yml",
            ROOT / "skills/deploy-issue-harness-agent/assets/coolify-agent-compose.yml",
            ROOT / "skills/deploy-issue-harness-agent/references/agent-contract.md",
            ROOT / "skills/deploy-issue-harness-agent/SKILL.md",
            ROOT / "skills/deploy-opencode-harness/SKILL.md",
        ]
        for path in runtime_files:
            content = path.read_text()
            self.assertNotIn("GITHUB_TOKEN", content, str(path))
            self.assertIn("GITHUB_APP_ID", content, str(path))
            self.assertIn("GITHUB_APP_INSTALLATION_ID", content, str(path))

        for relative in (
            "docker-compose.local.yml",
            "coolify/docker-compose.yml",
            "skills/deploy-issue-harness-agent/assets/coolify-agent-compose.yml",
        ):
            compose = (ROOT / relative).read_text()
            self.assertIn("GITHUB_APP_PRIVATE_KEY_PATH", compose)
            self.assertIn("HARNESS_COMMAND_TOKEN", compose)
            self.assertRegex(compose, r"github-app[^\n]*:ro")

    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(temporary.name)
        (root / ".harness").mkdir()
        (root / ".harness" / "config.json").write_text(json.dumps(config()))
        (root / ".harness" / "deploy_exact_revision.py").write_text(
            (ROOT / "skills/setup-coolify-cicd/assets/deploy_exact_revision.py").read_text()
        )
        (root / ".harness" / "coolify_client.py").write_text(
            (ROOT / "skills/setup-coolify-cicd/assets/coolify_client.py").read_text()
        )
        (root / ".harness" / "evidence_ledger.py").write_text(
            (ROOT / "skills/setup-coolify-cicd/evidence_ledger.py").read_text()
        )
        (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1","pg":"1"}}')
        (root / "package-lock.json").write_text("{}")
        (root / "Dockerfile").write_text("FROM scratch\n")
        (root / ".env.example").write_text("DATABASE_URL=\n")
        (root / ".github" / "ISSUE_TEMPLATE").mkdir(parents=True)
        (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").write_text("name: Agent task\n")
        (root / ".github" / "workflows").mkdir()
        workflows = compiled_workflows("nest-postgres")
        for name, content in workflows.items():
            (root / ".github" / "workflows" / name).write_text(content)
        (root / "src").mkdir()
        (root / "src" / "health.ts").write_text("const path = '/health';\n")
        return temporary, root

    def test_repository_doctor_accepts_ready_fixture(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        result = run_script("skills/setup-coolify-cicd/scripts/doctor.py", root, "--json", "--run-commands")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads(result.stdout)["ready"])

    def test_schema_v2_drives_doctor_workflow_and_reconciler(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        module = load_module("skills/setup-coolify-cicd/harness_config.py", "harness_config_consumers_v2")
        normalized = module.normalize_config(config())
        (root / ".harness" / "config.json").write_text(json.dumps(normalized))

        doctor = run_script(
            "skills/setup-coolify-cicd/scripts/doctor.py", root, "--json", "--run-commands"
        )
        workflow = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        reconcile = run_script("skills/setup-coolify-cicd/scripts/coolify_reconcile.py", root, "plan")

        self.assertEqual(doctor.returncode, 0, doctor.stderr + doctor.stdout)
        self.assertEqual(workflow.returncode, 0, workflow.stderr + workflow.stdout)
        self.assertEqual(reconcile.returncode, 0, reconcile.stderr + reconcile.stdout)
        self.assertEqual(
            json.loads(workflow.stdout)["capabilities"],
            ["coolify.application", "coolify.postgresql"],
        )

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

    def test_coolify_record_envelopes_are_explicit_and_fail_closed(self):
        module = load_module(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            "coolify_reconcile_record_envelopes",
        )
        records = [{"uuid": "application-1"}]
        self.assertEqual(module.response_records(records, "applications", "applications"), records)
        self.assertEqual(
            module.response_records({"data": records}, "applications", "applications"),
            records,
        )
        self.assertEqual(
            module.response_records({"applications": records}, "applications", "applications"),
            records,
        )
        self.assertEqual(
            module.response_object({"uuid": "application-1"}, "application"),
            {"uuid": "application-1"},
        )
        for payload in ([], "not-an-object", None):
            with self.subTest(object_payload=payload), self.assertRaisesRegex(
                RuntimeError, "application response must be an object"
            ):
                module.response_object(payload, "application")
        for payload in (
            {},
            {"data": records, "applications": records},
            {"data": "not-a-list"},
            ["not-an-object"],
        ):
            with self.subTest(payload=payload), self.assertRaisesRegex(
                RuntimeError, "applications response must contain one record list"
            ):
                module.response_records(payload, "applications", "applications")

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

    def test_coolify_apply_requires_explicit_production_approval_and_rollback_ref(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        environment = {
            **os.environ,
            "COOLIFY_URL": "http://127.0.0.1:1",
            "COOLIFY_TOKEN": "test-token",
        }
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "apply", "--allow-external-writes", env=environment,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--allow-production-writes", result.stderr)
        self.assertIn("--production-approval-ref", result.stderr)
        self.assertIn("--rollback-ref", result.stderr)

    def test_coolify_apply_rejects_symlinked_config_parent_before_external_access(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        harness_dir = root / ".harness"
        outside = root / "outside-harness"
        harness_dir.rename(outside)
        harness_dir.symlink_to(outside, target_is_directory=True)
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root,
            "apply",
            "--allow-external-writes",
            "--allow-production-writes",
            "--production-approval-ref", "change:HARNESS-42",
            "--rollback-ref", "1" * 40,
            env={**os.environ, "COOLIFY_URL": "http://127.0.0.1:1", "COOLIFY_TOKEN": "unused"},
        )
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertIn("symlink", result.stderr.lower())

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
        module = load_module("skills/setup-coolify-cicd/assets/coolify_client.py", "coolify_client_redaction")
        client = module.CoolifyClient(
            f"http://127.0.0.1:{server.server_port}",
            "test-token",
            module.AccessPolicy.from_mapping(fresh_access_policy()),
            allow_insecure_loopback=True,
        )
        with self.assertRaises(RuntimeError) as raised:
            client.request("GET", "/applications")
        self.assertNotIn(secret, str(raised.exception))
        self.assertIn("response body withheld", str(raised.exception))

    def test_privileged_client_requires_https_and_rejects_userinfo(self):
        module = load_module(
            "skills/setup-coolify-cicd/assets/coolify_client.py",
            "coolify_client_url_policy",
        )
        policy = module.AccessPolicy.from_mapping(fresh_access_policy())
        for url in ("http://coolify.example.test", "https://user@coolify.example.test"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                module.CoolifyClient(url, "test-token", policy)

    def test_privileged_client_does_not_follow_redirects_or_forward_authorization(self):
        destination_requests = []

        class Destination(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                destination_requests.append(self.headers.get("authorization"))
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

        destination = ThreadingHTTPServer(("127.0.0.1", 0), Destination)
        threading.Thread(target=destination.serve_forever, daemon=True).start()
        self.addCleanup(destination.server_close)
        self.addCleanup(destination.shutdown)

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(302)
                self.send_header(
                    "location", f"http://127.0.0.1:{destination.server_port}/stolen"
                )
                self.end_headers()

        source = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=source.serve_forever, daemon=True).start()
        self.addCleanup(source.server_close)
        self.addCleanup(source.shutdown)
        module = load_module(
            "skills/setup-coolify-cicd/assets/coolify_client.py",
            "coolify_client_redirect_policy",
        )
        client = module.CoolifyClient(
            f"http://127.0.0.1:{source.server_port}",
            "test-token",
            module.AccessPolicy.from_mapping(fresh_access_policy()),
            allow_insecure_loopback=True,
        )
        with self.assertRaisesRegex(RuntimeError, "redirects are denied"):
            client.request("GET", "/redirect")
        self.assertEqual(destination_requests, [])
        self.assertEqual(client.proxy_handler.proxies, {})

    def test_privileged_client_rejects_oversized_responses(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(2 * 1024 * 1024))
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        module = load_module(
            "skills/setup-coolify-cicd/assets/coolify_client.py",
            "coolify_client_response_limit",
        )
        client = module.CoolifyClient(
            f"http://127.0.0.1:{server.server_port}",
            "test-token",
            module.AccessPolicy.from_mapping(fresh_access_policy()),
            allow_insecure_loopback=True,
        )
        with self.assertRaisesRegex(RuntimeError, "response exceeds"):
            client.request("GET", "/oversized")

    def test_privileged_client_requires_exact_scopes_expiry_and_ip_allowlist(self):
        module = load_module(
            "skills/setup-coolify-cicd/assets/coolify_client.py",
            "coolify_client_access_policy",
        )
        cases = (
            ({**fresh_access_policy(), "scopes": ["read", "write", "root"]}, "scopes"),
            ({**fresh_access_policy(), "expiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=25)).isoformat()}, "24 hours"),
            ({**fresh_access_policy(), "ipAllowlisted": False}, "IP allowlist"),
        )
        for payload, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                module.AccessPolicy.from_mapping(payload)
        with self.assertRaisesRegex(ValueError, "HTTPS URL"):
            module.probe_https_health("http://stage.example.test/ready", attempts=1, sleep=lambda _seconds: None)

    def test_privileged_client_rejects_operations_outside_declared_scope(self):
        module = load_module(
            "skills/setup-coolify-cicd/assets/coolify_client.py",
            "coolify_client_operation_scope",
        )
        verify_client = module.CoolifyClient(
            "http://127.0.0.1:1",
            "test-token",
            module.AccessPolicy.from_mapping(fresh_access_policy("verify")),
            allow_insecure_loopback=True,
        )
        deploy_client = module.CoolifyClient(
            "http://127.0.0.1:1",
            "test-token",
            module.AccessPolicy.from_mapping(fresh_access_policy("deploy")),
            allow_insecure_loopback=True,
        )
        with self.assertRaisesRegex(ValueError, "write scope"):
            verify_client.request("PATCH", "/applications/app-stage", {})
        with self.assertRaisesRegex(ValueError, "write scope"):
            deploy_client.request("PATCH", "/applications/app-stage", {})
        with self.assertRaisesRegex(ValueError, "deploy scope"):
            verify_client.request("POST", "/deploy", {"uuid": "app-stage"})

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
            "if: github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'stage' && github.event.workflow_run.conclusion == 'success'",
            "if: always() && github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'stage' && github.event.workflow_run.conclusion == 'success'",
            1,
        ).replace("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    continue-on-error: true", 1)
        self.assertNotEqual(bypass, valid)
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

    def test_workflow_validator_rejects_modified_protected_auxiliary_workflows(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        cases = (
            (
                "backend-prepare.yml",
                "  contents: read",
                "  contents: write",
                "backend preparation workflow differs from exact canonical compilation",
            ),
            (
                "coolify-rollback.yml",
                "  workflow_dispatch:",
                "  push:\n    branches: [main]\n  workflow_dispatch:",
                "rollback workflow differs from exact canonical compilation",
            ),
            (
                "evidence-retention-checkpoint.yml",
                "  cancel-in-progress: false",
                "  cancel-in-progress: true",
                "retention checkpoint workflow differs from exact canonical compilation",
            ),
        )
        for name, source, replacement, message in cases:
            with self.subTest(name=name):
                path = root / ".github" / "workflows" / name
                original = path.read_text()
                path.write_text(original.replace(source, replacement, 1))
                result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stdout)
                path.write_text(original)

    def test_workflow_validator_rejects_backend_preparation_from_tag_ref(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        path = root / ".github" / "workflows" / "backend-prepare.yml"
        original = path.read_text()
        unsafe = original.replace(
            "if: github.ref_name == 'main'",
            "if: github.ref_type == 'tag'",
            1,
        )
        self.assertNotEqual(unsafe, original)
        path.write_text(unsafe)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("backend preparation jobs must be main-only", result.stdout)

    def test_workflow_validator_rejects_unscrubbed_backend_receipt_runtime(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        path = root / ".github" / "workflows" / "backend-prepare.yml"
        original = path.read_text()
        unsafe = original.replace(
            "/usr/bin/env -i PATH=/usr/bin:/bin",
            "env",
            1,
        )
        self.assertNotEqual(unsafe, original)
        path.write_text(unsafe)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("scrubbed immutable trusted Git object", result.stdout)

    def test_workflow_validator_rejects_bootstrap_dispatch_resource_override(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        path = root / ".github" / "workflows" / "bootstrap-deployment-evidence.yml"
        original = path.read_text()
        unsafe = original.replace(
            "RESOURCE_UUID: ${{ vars.COOLIFY_RESOURCE_UUID }}",
            "RESOURCE_UUID: ${{ inputs.resource_uuid }}",
            1,
        )
        self.assertNotEqual(unsafe, original)
        path.write_text(unsafe)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("bootstrap must bind resource UUID and health URL only", result.stdout)

    def test_workflow_validator_rejects_post_compensation_restoration_publication(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        path = root / ".github" / "workflows" / "coolify-deploy.yml"
        original = path.read_text()
        before_production, production = original.rsplit(
            "      - name: Compensate to verified predecessor",
            1,
        )
        unsafe = before_production + "      - name: restoration-successor after compensation" + production
        self.assertNotEqual(unsafe, original)
        path.write_text(unsafe)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("failed runs must not publish authority after compensation", result.stdout)

    def test_workflow_validator_rejects_tag_checkpoint_dispatch(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        path = root / ".github" / "workflows" / "evidence-retention-checkpoint.yml"
        original = path.read_text()
        unsafe = original.replace(
            "if: github.ref_name == 'main'",
            "if: github.ref_type == 'tag'",
            1,
        )
        self.assertNotEqual(unsafe, original)
        path.write_text(unsafe)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("retention checkpoint jobs must be main-only", result.stdout)

    def test_workflow_validator_rejects_verify_permission_override(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflow_path.write_text(workflow_path.read_text().replace(
            "  verify:\n    if: github.event_name == 'workflow_dispatch' && github.ref_name == 'main'\n    uses: ./.github/workflows/ci.yml",
            "  verify:\n    if: github.event_name == 'workflow_dispatch' && github.ref_name == 'main'\n    permissions: write-all\n    uses: ./.github/workflows/ci.yml",
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
            valid.replace('      - run: "echo migrate-stage"', '      - run: "echo migrate-stage"\n        if: ${{ false }}', 1),
            valid.replace('      - run: "echo migrate-stage"', '      - run: "echo migrate-stage"\n        shell: echo {0}', 1),
            valid.replace(
                "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
                "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          repository: attacker/evil",
                1,
            ),
            valid.replace(
                "        DATABASE_URL: ${{ secrets.DATABASE_URL }}",
                "        DATABASE_URL: ${{ secrets.DATABASE_URL }}\n        EXTRA: ${{ secrets['EXTRA'] }}",
                1,
            ),
        )
        for unsafe in mutations:
            with self.subTest(unsafe=unsafe):
                self.assertNotEqual(unsafe, valid)
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

    def test_workflow_validator_rejects_modified_exact_revision_helper(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        helper = root / ".harness" / "deploy_exact_revision.py"
        helper.write_text(helper.read_text().replace("MINIMUM_COOLIFY_VERSION = (4, 1, 2)", "MINIMUM_COOLIFY_VERSION = (4, 0, 0)"))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("exact revision helper differs", result.stdout)

    def test_workflow_validator_rejects_modified_evidence_ledger(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        ledger = root / ".harness" / "evidence_ledger.py"
        ledger.write_text(ledger.read_text() + "\n# drift\n")
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("evidence ledger differs from the reviewed template", result.stdout)

    def test_ci_validator_rejects_silent_skip_or_command_drift(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        workflow = root / ".github" / "workflows" / "ci.yml"
        workflow.write_text(workflow.read_text().replace('- run: "true"', '- run: "true --if-present"', 1))
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("CI workflow differs from exact configured gates", result.stdout)

    def test_workflow_validator_accepts_convex_gate_graph(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["project"]["stack"] = "convex"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        for name, content in compiled_workflows("convex").items():
            (root / ".github" / "workflows" / name).write_text(content)
        result = run_script("skills/setup-coolify-cicd/scripts/validate_workflow.py", root)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_workflow_validator_requires_both_hybrid_gates(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["project"]["stack"] = "hybrid"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        workflow_path = root / ".github" / "workflows" / "coolify-deploy.yml"
        workflows = compiled_workflows("hybrid")
        workflow = workflows["coolify-deploy.yml"]
        for name, content in workflows.items():
            (root / ".github" / "workflows" / name).write_text(content)
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
            **coolify_test_environment(f"http://127.0.0.1:{server.server_port}"),
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
                {"databaseUuid": "postgres-stage", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage", "ready": True, "readinessSource": "coolify-health"},
                {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production", "ready": True, "readinessSource": "coolify-health"},
            ],
            "deliveryEnvironments": [
                {"lane": "stage", "environmentName": "stage", "branch": "stage", "credentialScope": "github-environment:stage", "requiredReviewers": 0, "preventSelfReview": False},
                {"lane": "production", "environmentName": "production", "branch": "main", "credentialScope": "github-environment:production", "requiredReviewers": 1, "preventSelfReview": True},
            ],
        }))
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "apply", "--allow-external-writes", "--allow-production-writes",
            "--production-approval-ref", "change:HARNESS-42",
            "--rollback-ref", "1" * 40,
            "--inventory-json", inventory_path, env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        change_control = json.loads(result.stdout)["productionChangeControl"]
        self.assertEqual(change_control["approvalRef"], "change:HARNESS-42")
        self.assertEqual(change_control["rollbackRef"], "1" * 40)
        created = [item[2]["name"] for item in requests if item[0] == "POST" and item[1].endswith("/environments")]
        self.assertEqual(created, ["stage", "production"])
        self.assertEqual(
            [item[2]["key"] for item in requests if item[0] == "POST" and item[1].endswith("/envs")],
            ["DATABASE_URL", "DATABASE_URL"],
        )
        self.assertFalse(any(item[0] == "POST" and item[1].endswith("/applications/private-github-app") for item in requests))
        persisted = json.loads((root / ".harness" / "config.json").read_text())
        application = next(
            item for item in persisted["capabilities"] if item["kind"] == "coolify.application"
        )
        self.assertEqual(persisted["schemaVersion"], 2)
        self.assertNotIn("stack", persisted["project"])
        self.assertEqual(
            (
                application["bindings"]["stage"]["resourceRef"],
                application["bindings"]["production"]["resourceRef"],
            ),
            ("app-stage", "app-production"),
        )

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
                {"databaseUuid": "postgres-stage", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage", "ready": True, "readinessSource": "coolify-health"},
                {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production", "ready": True, "readinessSource": "coolify-health"},
            ],
            "deliveryEnvironments": [
                {"lane": "stage", "environmentName": "stage", "branch": "stage", "credentialScope": "github-environment:stage", "requiredReviewers": 0, "preventSelfReview": False},
                {"lane": "production", "environmentName": "production", "branch": "main", "credentialScope": "github-environment:production", "requiredReviewers": 1, "preventSelfReview": True},
            ],
        }))
        environment = {
            **coolify_test_environment(f"http://127.0.0.1:{server.server_port}"),
            "STAGE_DATABASE_URL": "postgres://stage",
            "PRODUCTION_DATABASE_URL": "postgres://production",
        }
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "apply", "--allow-external-writes", "--allow-production-writes",
            "--production-approval-ref", "change:HARNESS-42",
            "--rollback-ref", "1" * 40,
            "--inventory-json", inventory_path, env=environment,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(any(method == "POST" for method, _path in requests), requests)

    def test_coolify_database_inventory_must_prove_postgresql(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        inventory_path = root / "inventory.json"
        inventory_path.write_text(json.dumps({
            **fresh_inventory_metadata(),
            "applications": [{
                "applicationUuid": "app-stage", "projectUuid": "project-1",
                "serverUuid": "server-1", "environmentName": "stage",
                "name": "service-stage", "repository": "acme/service",
                "branch": "stage", "domain": "https://stage.example.test",
            }],
            "databases": [
                {"databaseUuid": "postgres-stage", "databaseType": "mysql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage", "ready": True, "readinessSource": "coolify-health"},
                {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production", "ready": True, "readinessSource": "coolify-health"},
            ],
        }))
        environment = coolify_test_environment("http://127.0.0.1:1", purpose="verify")
        result = run_script(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            root, "verify", "--inventory-json", inventory_path, env=environment,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("databaseType", result.stderr)

    def test_inventory_freshness_requires_uuid_and_unexpired_bounded_window(self):
        module = load_module(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            "coolify_reconcile_inventory_freshness",
        )
        module.validate_inventory_metadata(fresh_inventory_metadata())
        invalid_id = fresh_inventory_metadata()
        invalid_id["inventoryId"] = "operator-said-fresh"
        with self.assertRaisesRegex(ValueError, "canonical UUID"):
            module.validate_inventory_metadata(invalid_id)
        expired = fresh_inventory_metadata()
        expired["expiresAt"] = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
        ).isoformat()
        with self.assertRaisesRegex(ValueError, "freshness proof is expired"):
            module.validate_inventory_metadata(expired)

    def test_coolify_inventory_rejects_untyped_or_extra_nested_evidence_before_use(self):
        module = load_module(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            "coolify_reconcile_typed_sections",
        )
        application = {
            "applicationUuid": "app-stage",
            "projectUuid": "project-1",
            "serverUuid": "server-1",
            "environmentName": "stage",
            "name": "service-stage",
            "repository": "acme/service",
            "branch": "stage",
            "domain": "https://stage.example.test",
        }
        payload = {**fresh_inventory_metadata(), "applications": [application]}
        module.validate_inventory_payload(payload)

        extra = json.loads(json.dumps(payload))
        extra["applications"][0]["token"] = "must-not-be-accepted"
        with self.assertRaisesRegex(ValueError, r"applications\[0\].*unsupported fields"):
            module.validate_inventory_payload(extra)

        wrong_type = {
            **fresh_inventory_metadata(),
            "databases": [{
                "databaseUuid": "postgres-stage",
                "databaseType": "postgresql",
                "projectUuid": "project-1",
                "serverUuid": "server-1",
                "environmentName": "stage",
                "ready": "true",
                "readinessSource": "coolify-health",
            }],
        }
        with self.assertRaisesRegex(ValueError, r"databases\[0\].*ready.*boolean"):
            module.validate_inventory_payload(wrong_type)

    def test_hybrid_backend_evidence_requires_ready_postgres_and_convex_lanes(self):
        module = load_module(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            "coolify_reconcile_hybrid_evidence",
        )
        payload = hybrid_config_v2()
        databases = [
            {"databaseUuid": "postgres-stage", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "stage", "ready": True, "readinessSource": "coolify-health"},
            {"databaseUuid": "postgres-production", "databaseType": "postgresql", "projectUuid": "project-1", "serverUuid": "server-1", "environmentName": "production", "ready": True, "readinessSource": "coolify-health"},
        ]
        deployments = [
            {"capabilityId": "convex", "lane": "stage", "projectRef": "convex-project-stage", "deploymentRef": "convex-deployment-stage", "deploymentType": "permanent", "deployKeyRef": "STAGE_CONVEX_DEPLOY_KEY", "deployKeyScope": "convex-deployment-stage", "ready": True, "readinessSource": "convex-deployment"},
            {"capabilityId": "convex", "lane": "production", "projectRef": "convex-project-production", "deploymentRef": "convex-deployment-production", "deploymentType": "permanent", "deployKeyRef": "PRODUCTION_CONVEX_DEPLOY_KEY", "deployKeyScope": "convex-deployment-production", "ready": True, "readinessSource": "convex-deployment"},
        ]

        with self.assertRaisesRegex(ValueError, "Convex verification requires"):
            module.verify_convex_deployments(payload, [])
        unready_databases = json.loads(json.dumps(databases))
        unready_databases[0]["ready"] = False
        with self.assertRaisesRegex(RuntimeError, "wrong ready"):
            module.verify_postgresql_backends(payload, unready_databases)
        wrong_key_scope = json.loads(json.dumps(deployments))
        wrong_key_scope[0]["deployKeyScope"] = "convex-deployment-production"
        with self.assertRaisesRegex(RuntimeError, "wrong deployKeyScope"):
            module.verify_convex_deployments(payload, wrong_key_scope)
        postgres_report = module.verify_postgresql_backends(payload, databases)
        convex_report = module.verify_convex_deployments(payload, deployments)

        self.assertEqual({item["lane"] for item in postgres_report}, {"stage", "production"})
        self.assertEqual({item["lane"] for item in convex_report}, {"stage", "production"})
        self.assertTrue(all(item["ready"] for item in postgres_report + convex_report))

    def test_delivery_environment_evidence_proves_approval_and_credential_isolation(self):
        module = load_module(
            "skills/setup-coolify-cicd/scripts/coolify_reconcile.py",
            "coolify_reconcile_delivery_policy",
        )
        records = [
            {"lane": "stage", "environmentName": "stage", "branch": "stage", "credentialScope": "github-environment:stage", "requiredReviewers": 0, "preventSelfReview": False},
            {"lane": "production", "environmentName": "production", "branch": "main", "credentialScope": "github-environment:production", "requiredReviewers": 1, "preventSelfReview": True},
        ]
        report = module.verify_delivery_environments(hybrid_config_v2(), records)
        self.assertEqual({item["lane"] for item in report}, {"stage", "production"})
        unsafe = json.loads(json.dumps(records))
        unsafe[1]["credentialScope"] = unsafe[0]["credentialScope"]
        with self.assertRaisesRegex(RuntimeError, "credentialScope"):
            module.verify_delivery_environments(hybrid_config_v2(), unsafe)

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
        deploy_helper = ROOT / "skills/setup-coolify-cicd/assets/deploy_exact_revision.py"
        client_helper = ROOT / "skills/setup-coolify-cicd/assets/coolify_client.py"
        compose = (ROOT / "skills/deploy-issue-harness-agent/assets/coolify-agent-compose.yml").read_text()
        self.assertTrue(deploy_helper.is_file())
        self.assertTrue(client_helper.is_file())
        self.assertEqual(workflow.count("python3 .harness/deploy_exact_revision.py"), 2)
        self.assertEqual(workflow.count("group: coolify-resource-${{ vars.COOLIFY_RESOURCE_UUID }}"), 2)
        self.assertIn('--revision "$GITHUB_SHA"', workflow)
        self.assertNotIn('/api/v1/deploy"', workflow)
        self.assertEqual(workflow.count("secrets.COOLIFY_PIN_TOKEN"), 4)
        self.assertEqual(workflow.count("secrets.COOLIFY_DEPLOY_TOKEN"), 4)
        self.assertEqual(workflow.count("secrets.COOLIFY_VERIFY_TOKEN"), 2)
        self.assertNotIn("secrets.COOLIFY_TOKEN", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("${HARNESS_DATA_DIR:?set /opt/issue-harness/owner-repository}:${HARNESS_DATA_DIR:?set /opt/issue-harness/owner-repository}", compose)
        self.assertNotIn("harness-data:/data", compose)
        self.assertNotIn("/var/run/docker.sock", compose)
        self.assertNotIn("SANDBOX_", compose)
        self.assertIn("OPENCODE_WEB_IMAGE", compose)
        self.assertIn("__HARNESS_CONVEX_DEPLOY_STAGE__", (ROOT / "skills/setup-coolify-cicd/assets/convex-delivery-jobs.yml").read_text())
        self.assertIn("__HARNESS_MIGRATE_PRODUCTION__", (ROOT / "skills/setup-coolify-cicd/assets/nest-migration-jobs.yml").read_text())

    def test_all_remote_actions_are_full_sha_pinned_and_ci_has_no_silent_skips(self):
        files = [
            ROOT / "skills/setup-coolify-cicd/assets/ci.yml",
            ROOT / "skills/setup-coolify-cicd/assets/coolify-deploy.yml",
            ROOT / "skills/setup-coolify-cicd/assets/nest-migration-jobs.yml",
            ROOT / "skills/setup-coolify-cicd/assets/convex-delivery-jobs.yml",
            ROOT / "skills/setup-coolify-cicd/assets/backend-prepare.yml",
            ROOT / "skills/setup-coolify-cicd/assets/backend-prepare-postgres.yml",
            ROOT / "skills/setup-coolify-cicd/assets/backend-prepare-convex.yml",
            ROOT / "skills/setup-coolify-cicd/assets/coolify-rollback.yml",
            ROOT / "skills/setup-coolify-cicd/assets/bootstrap-deployment-evidence.yml",
            ROOT / "skills/setup-coolify-cicd/assets/evidence-retention-checkpoint.yml",
            ROOT / ".github/workflows/ci.yml",
            ROOT / ".github/workflows/publish-images.yml",
        ]
        action = re.compile(r"uses:\s+([^\s]+)")
        for path in files:
            with self.subTest(path=path):
                text = path.read_text()
                self.assertNotIn("--if-present", text)
                for reference in action.findall(text):
                    if reference.startswith("./"):
                        continue
                    self.assertRegex(reference, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")

    def test_image_publish_workflow_attests_canonical_subject_and_source_revision(self):
        workflow = (ROOT / ".github/workflows/publish-images.yml").read_text()
        self.assertIn("attestations: write", workflow)
        self.assertIn(
            "actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661",
            workflow,
        )
        self.assertIn("subject-digest: ${{ steps.build.outputs.digest }}", workflow)
        self.assertIn("push-to-registry: true", workflow)
        self.assertIn("SOURCE_COMMIT=${{ github.sha }}", workflow)
        self.assertNotIn("\n    tags:", workflow)
        self.assertNotIn("refs/tags/", workflow)
        self.assertNotIn("startsWith(github.ref", workflow)
        self.assertIn('if [[ "$GITHUB_REF" != "refs/heads/main" ]]', workflow)
        self.assertLess(
            workflow.index("Validate trusted publication ref"),
            workflow.index("uses: actions/checkout@"),
        )
        for dockerfile in (ROOT / "services/issue-harness/Dockerfile", ROOT / "opencode/Dockerfile"):
            with self.subTest(dockerfile=dockerfile):
                text = dockerfile.read_text()
                self.assertIn("org.opencontainers.image.source", text)
                self.assertIn("org.opencontainers.image.revision", text)

    def test_exact_revision_deploy_pins_polls_and_checks_health_in_order(self):
        module = load_module(
            "skills/setup-coolify-cicd/assets/deploy_exact_revision.py",
            "deploy_exact_revision_order",
        )
        revision = "a" * 40
        events = []

        class Api:
            def version(self):
                events.append(("GET", "/version"))
                return "v4.1.2"

            def request(self, method, path, body=None):
                events.append((method, path, body))
                responses = {
                    ("GET", "/deployments/deployment-prior", 1): {"status": "finished", "commit": "b" * 40, "resource_uuid": "app-stage"},
                    ("GET", "/applications/app-stage", 1): {"git_commit_sha": "b" * 40, "is_auto_deploy_enabled": False},
                    ("PATCH", "/applications/app-stage", 1): {"uuid": "app-stage"},
                    ("GET", "/applications/app-stage", 2): {"git_commit_sha": revision, "is_auto_deploy_enabled": False},
                    ("POST", "/deploy", 1): {"deployments": [{"resource_uuid": "app-stage", "deployment_uuid": "deployment-1"}]},
                    ("GET", "/deployments/deployment-1", 1): {"status": "finished", "commit": revision},
                    ("GET", "/applications/app-stage", 3): {"git_commit_sha": revision, "is_auto_deploy_enabled": False},
                }
                occurrence = sum(1 for event in events if event[0] == method and event[1] == path)
                return responses[(method, path, occurrence)]

        report = module.deploy_exact_revision(
            Api(), "app-stage", revision, "https://stage.example.test/ready",
            health_probe=lambda url: events.append(("HEALTH", url)),
            sleep=lambda _seconds: None,
            rollback_evidence={
                "schemaVersion": 1,
                "recordType": "coolify-exact-deployment",
                "writer": "project-harness/deploy_exact_revision.py",
                "resourceUuid": "app-stage",
                "revision": "b" * 40,
                "deploymentUuid": "deployment-prior",
                "healthUrlSha256": hashlib.sha256(b"https://stage.example.test/ready").hexdigest(),
                "healthVerified": True,
                "outcome": "deployment-succeeded",
            },
        )

        self.assertTrue(report["verified"])
        self.assertEqual(report["revision"], revision)
        self.assertEqual(events[-1][0], "HEALTH")
        patch_index = next(index for index, event in enumerate(events) if event[0] == "PATCH")
        trigger_index = next(index for index, event in enumerate(events) if event[0] == "POST")
        self.assertLess(patch_index, trigger_index)
        self.assertEqual(events[patch_index][2], {"git_commit_sha": revision, "is_auto_deploy_enabled": False})

    def test_exact_revision_deploy_rejects_wrong_commit_before_health(self):
        module = load_module(
            "skills/setup-coolify-cicd/assets/deploy_exact_revision.py",
            "deploy_exact_revision_wrong_commit",
        )
        revision = "a" * 40
        health = []

        class Api:
            def version(self):
                return "v4.1.2"

            def request(self, method, path, body=None):
                if path == "/deployments/deployment-prior":
                    return {"status": "finished", "commit": revision, "resource_uuid": "app-stage"}
                if method == "GET" and path == "/applications/app-stage":
                    return {"git_commit_sha": revision, "is_auto_deploy_enabled": False}
                if method == "PATCH":
                    return {"uuid": "app-stage"}
                if method == "POST":
                    return {"deployments": [{"resource_uuid": "app-stage", "deployment_uuid": "deployment-1"}]}
                if path == "/deployments/deployment-1":
                    return {"status": "finished", "commit": "b" * 40}
                raise AssertionError((method, path, body))

        with self.assertRaisesRegex(RuntimeError, "expected exact revision"):
            module.deploy_exact_revision(
                Api(), "app-stage", revision, "https://stage.example.test/ready",
                health_probe=health.append, sleep=lambda _seconds: None,
                rollback_evidence={
                    "schemaVersion": 1,
                    "recordType": "coolify-exact-deployment",
                    "writer": "project-harness/deploy_exact_revision.py",
                    "resourceUuid": "app-stage",
                    "revision": revision,
                    "deploymentUuid": "deployment-prior",
                    "healthUrlSha256": hashlib.sha256(b"https://stage.example.test/ready").hexdigest(),
                    "healthVerified": True,
                    "outcome": "deployment-succeeded",
                },
            )
        self.assertEqual(health, [])

    def test_exact_revision_deploy_requires_coolify_4_1_2_or_newer(self):
        module = load_module(
            "skills/setup-coolify-cicd/assets/deploy_exact_revision.py",
            "deploy_exact_revision_version",
        )

        class Api:
            def version(self):
                return "v4.1.1"

        with self.assertRaisesRegex(RuntimeError, "Coolify >= 4.1.2"):
            module.deploy_exact_revision(
                Api(), "app-stage", "a" * 40, "https://stage.example.test/ready",
                health_probe=lambda _url: None, sleep=lambda _seconds: None,
            )

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

    def test_diagnostics_verifier_uses_fail_closed_http_transport(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_diagnostics.py",
            "verify_diagnostics_transport",
        )
        destination_authorization = []

        class Destination(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                destination_authorization.append(self.headers.get("authorization"))
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

        destination = ThreadingHTTPServer(("127.0.0.1", 0), Destination)
        threading.Thread(target=destination.serve_forever, daemon=True).start()
        self.addCleanup(destination.server_close)
        self.addCleanup(destination.shutdown)

        class Source(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header(
                        "location", f"http://127.0.0.1:{destination.server_port}/stolen"
                    )
                    self.end_headers()
                    return
                if self.path == "/oversized":
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(module.MAX_RESPONSE_BYTES + 1))
                    self.end_headers()
                    return
                payload = b"[]"
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
        threading.Thread(target=source.serve_forever, daemon=True).start()
        self.addCleanup(source.server_close)
        self.addCleanup(source.shutdown)

        base = f"http://127.0.0.1:{source.server_port}"
        with mock.patch.dict(os.environ, {
            "HTTP_PROXY": f"http://127.0.0.1:{destination.server_port}",
            "http_proxy": f"http://127.0.0.1:{destination.server_port}",
            "NO_PROXY": "",
            "no_proxy": "",
        }):
            opener = module.secure_opener()
            with self.assertRaises(urllib.error.HTTPError):
                module.request_json(opener, base + "/redirect", "diagnostic-secret")
            with self.assertRaisesRegex(ValueError, "size limit"):
                module.request_json(opener, base + "/oversized", "diagnostic-secret")
            with self.assertRaisesRegex(ValueError, "JSON object"):
                module.request_json(opener, base + "/scalar", "diagnostic-secret")
        self.assertEqual(destination_authorization, [])

    def test_diagnostics_verifier_rejects_ambiguous_origins_and_endpoint_queries(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_diagnostics.py",
            "verify_diagnostics_url_contract",
        )
        urls = (
            "https://diagnostics.example.test/health",
            "https://diagnostics.example.test/query",
            "https://diagnostics.example.test/policy",
        )
        with self.assertRaisesRegex(ValueError, "userinfo"):
            module.validate_endpoints(
                urls,
                "https://operator:secret@diagnostics.example.test",
                False,
            )
        with self.assertRaisesRegex(ValueError, "query"):
            module.validate_endpoints(
                (urls[0] + "?secret=value", urls[1], urls[2]),
                "https://diagnostics.example.test",
                False,
            )

    def test_diagnostics_log_schema_compatibility_is_explicit_and_bounded(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_diagnostics.py",
            "verify_diagnostics_log_schema",
        )
        self.assertEqual(module.extract_log_items({"items": []}), [])
        self.assertEqual(module.extract_log_items({"logs": [{"message": "ready"}]}), [
            {"message": "ready"}
        ])
        for payload in (
            {},
            {"items": [], "logs": []},
            {"items": "not-a-list"},
            {"items": ["not-structured"]},
            {"items": [{}] * 11},
        ):
            with self.subTest(payload=payload), self.assertRaisesRegex(
                ValueError, "exactly one bounded items or logs list"
            ):
                module.extract_log_items(payload)

    def test_agent_validator_accepts_bound_fixture(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        agent = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(agent.returncode, 0, agent.stderr + agent.stdout)

    def test_agent_validator_rejects_missing_repository_assets(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").unlink()
        payload = config()
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(any("agent-task.yml" in error for error in report["errors"]))

    def test_agent_validator_rejects_floating_opencode_image(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["opencodeWebImage"] = "opencode-web:latest"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertTrue(any("sha256" in item for item in report["errors"]))

    def test_agent_validator_rejects_forked_image_coordinates_even_with_a_digest(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["harnessImage"] = "ghcr.io/attacker/issue-harness@sha256:" + "a" * 64
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        self.assertIn("canonical coordinate", result.stdout)

    def test_agent_inventory_proves_rollout_refs_but_cannot_assert_provenance(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "verify_agent_image_provenance",
        )
        issue = config()["issueAgent"]
        expected = {
            "applicationUuid": issue["applicationUuid"],
            "serverUuid": issue["serverUuid"],
            "harnessImage": issue["harnessImage"],
            "opencodeWebImage": issue["opencodeWebImage"],
            "dataDir": issue["dataDir"],
            "replicas": 1,
        }
        inventory = agent_inventory(issue)
        self.assertEqual(module.verify_inventory(inventory, expected), [])

        forged = json.loads(json.dumps(inventory))
        forged["opencodeWebProvenanceVerified"] = True
        self.assertTrue(any("unsupported fields" in error for error in module.verify_inventory(forged, expected)))
        wrong_rollout = json.loads(json.dumps(inventory))
        wrong_rollout["rolloutHarnessImage"] = "ghcr.io/void0dev/issue-harness@sha256:" + "e" * 64
        self.assertTrue(any("rollout" in error for error in module.verify_inventory(wrong_rollout, expected)))

    def test_agent_validator_rejects_shared_data_root(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["dataDir"] = "/var/lib"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-issue-harness-agent/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        self.assertIn("per-repository child", result.stdout)

    def test_agent_online_verification_uses_distinct_operational_contracts(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                responses = {
                    "/live": {"status": "alive"},
                    "/ready": {"status": "ready"},
                    "/identity": {
                        "repository": "acme/service",
                        "workspaceOrigin": "https://github.com/acme/service.git",
                    },
                    "/health/worker": healthy_worker_contract(),
                }
                authorized = self.path != "/identity" or self.headers.get("authorization") == "Bearer health-secret"
                payload = json.dumps(responses.get(self.path, {"status": "unknown"})).encode()
                self.send_response(200 if self.path in responses and authorized else 401 if self.path == "/identity" else 404)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        issue, provenance_arguments, fake_bin = install_fake_attestation_materials(root)
        inventory_path = root / "agent-inventory.json"
        inventory_path.write_text(json.dumps(agent_inventory(issue)))
        origin = f"http://127.0.0.1:{server.server_port}"
        result = run_script(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            root,
            "--health-origin", origin,
            "--inventory-json", inventory_path,
            *provenance_arguments,
            env={
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
                "HARNESS_TEST_ALLOW_INSECURE_LOOPBACK": "1",
                "AGENT_HEALTH_TOKEN": "health-secret",
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["livenessVerified"])
        self.assertTrue(report["readinessVerified"])
        self.assertTrue(report["identityVerified"])
        self.assertTrue(report["workerVerified"])
        self.assertTrue(report["provenanceVerified"])

    def test_agent_health_origin_is_https_and_expands_to_fixed_paths(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "verify_agent_operational_urls",
        )
        origin = "https://harness.example.test"
        self.assertEqual(module.validate_health_origin(origin), [])
        self.assertEqual(module.operational_urls(origin), {
            "liveness": f"{origin}/live",
            "readiness": f"{origin}/ready",
            "identity": f"{origin}/identity",
            "worker": f"{origin}/health/worker",
        })

        errors = module.validate_health_origin(
            "http://user:password@harness.example.test/wrong?secret=yes"
        )
        self.assertTrue(any("HTTPS" in error for error in errors))
        self.assertTrue(any("userinfo, query, or fragment" in error for error in errors))
        self.assertTrue(any("origin without a path" in error for error in errors))

    def test_agent_operational_probe_rejects_redirects_and_oversized_json_structurally(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == "/live":
                    self.send_response(302)
                    self.send_header("location", "/ready")
                    self.end_headers()
                    return
                responses = {
                    "/ready": {"status": "ready"},
                    "/identity": {
                        "repository": "acme/service",
                        "workspaceOrigin": "https://github.com/acme/service.git",
                    },
                    "/health/worker": {"padding": "x" * 5000},
                }
                payload = json.dumps(responses.get(self.path, {"status": "unknown"})).encode()
                self.send_response(200 if self.path in responses else 404)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        inventory_path = root / "agent-inventory.json"
        inventory_path.write_text(json.dumps(agent_inventory(config()["issueAgent"])))
        result = run_script(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            root,
            "--health-origin", f"http://127.0.0.1:{server.server_port}",
            "--inventory-json", inventory_path,
            env={
                **os.environ,
                "HARNESS_TEST_ALLOW_INSECURE_LOOPBACK": "1",
                "AGENT_HEALTH_TOKEN": "health-secret",
            },
        )
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertIn("liveness operational contract request failed", report["errors"])
        self.assertIn("worker operational contract request failed", report["errors"])

    def test_agent_inventory_rejects_and_never_echoes_extra_secret_fields(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                responses = {
                    "/live": {"status": "alive"},
                    "/ready": {"status": "ready"},
                    "/identity": {
                        "repository": "acme/service",
                        "workspaceOrigin": "https://github.com/acme/service.git",
                    },
                    "/health/worker": healthy_worker_contract(),
                }
                authorized = self.path != "/identity" or self.headers.get("authorization") == "Bearer health-secret"
                payload = json.dumps(responses.get(self.path, {"status": "unknown"})).encode()
                self.send_response(200 if self.path in responses and authorized else 401 if self.path == "/identity" else 404)
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
        inventory = agent_inventory(issue)
        inventory["GITHUB_TOKEN"] = secret
        inventory_path.write_text(json.dumps(inventory))
        result = run_script(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            root,
            "--health-origin", f"http://127.0.0.1:{server.server_port}",
            "--inventory-json", inventory_path,
            env={
                **os.environ,
                "HARNESS_TEST_ALLOW_INSECURE_LOOPBACK": "1",
                "AGENT_HEALTH_TOKEN": "health-secret",
            },
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(secret, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertFalse(report["inventoryVerified"])
        self.assertTrue(any("unsupported fields" in error for error in report["errors"]))


if __name__ == "__main__":
    unittest.main()
