import datetime
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(relative: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def verification_result(subject: str, source_commit: str, source_ref: str, run_id: str):
    image_name, digest = subject.rsplit("@sha256:", 1)
    workflow_uri = (
        "https://github.com/Void0dev/harness/"
        f".github/workflows/publish-images.yml@{source_ref}"
    )
    return [{
        "verificationResult": {
            "statement": {
                "subject": [{"name": image_name, "digest": {"sha256": digest}}],
            },
            "signature": {
                "certificate": {
                    "sourceRepositoryURI": "https://github.com/Void0dev/harness",
                    "sourceRepositoryDigest": source_commit,
                    "sourceRepositoryRef": source_ref,
                    "githubWorkflowRepository": "Void0dev/harness",
                    "githubWorkflowRef": source_ref,
                    "buildSignerURI": workflow_uri,
                    "runnerEnvironment": "github-hosted",
                    "runInvocationURI": (
                        "https://github.com/Void0dev/harness/actions/runs/"
                        f"{run_id}/attempts/1"
                    ),
                }
            },
        }
    }]


class ProductContractTest(unittest.TestCase):
    def test_repository_has_no_legacy_convex_demo_runtime(self):
        package = (ROOT / "package.json").read_text()
        compose = (ROOT / "coolify/docker-compose.yml").read_text()
        self.assertFalse((ROOT / "apps" / "convex-demo").exists())
        self.assertNotIn("convex-demo", package)
        self.assertNotIn("convex-demo", compose)

    def test_issue_harness_dockerfile_does_not_embed_a_sandbox_runtime(self):
        dockerfile = (ROOT / "services/issue-harness/Dockerfile").read_text()
        self.assertNotIn("docker.io", dockerfile)
        self.assertNotIn("docker-cli", dockerfile)
        self.assertNotIn("opencode-ai", dockerfile)

    def test_opencode_child_sessions_replace_sandcastle_and_model_broker(self):
        package = (ROOT / "services/issue-harness/package.json").read_text()
        compose = (ROOT / "docker-compose.local.yml").read_text()
        runner = (ROOT / "services/issue-harness/src/runner.ts").read_text()
        publication = (ROOT / ".github/workflows/publish-images.yml").read_text()
        self.assertNotIn("@ai-hero/sandcastle", package)
        self.assertNotIn("model-broker", compose)
        self.assertNotIn("SANDBOX_", compose)
        self.assertNotIn("sandcastle-harness", publication)
        self.assertNotIn(".sandcastle/Dockerfile", publication)
        self.assertIn("opencode-web", publication)
        self.assertIn("opencode/Dockerfile", publication)
        self.assertIn("client.createChild", runner)
        self.assertIn("client.continueSession", runner)
        self.assertIn("parentSessionId", runner)

    def test_harness_progress_uses_one_persistent_web_card(self):
        client = (ROOT / "services/issue-harness/src/opencode-client.ts").read_text()
        state = (ROOT / "services/issue-harness/src/state.ts").read_text()
        web = (ROOT / "opencode/web-entry.mjs").read_text()
        dockerfile = (ROOT / "opencode/Dockerfile").read_text()
        self.assertNotIn("appendParentUpdate", client)
        self.assertIn("taskView", state)
        self.assertIn("injectHarnessAssets", web)
        self.assertIn("/__harness/api/tasks", web)
        self.assertIn("COPY opencode/ui /opt/opencode/ui", dockerfile)

    def test_linux_images_normalize_windows_scripts_and_create_opencode_state(self):
        harness = (ROOT / "services/issue-harness/Dockerfile").read_text()
        web = (ROOT / "opencode/Dockerfile").read_text()
        self.assertIn("sed -i 's/\\r$//'", harness)
        self.assertIn("/home/opencode/.local/state", web)
        self.assertIn("chown -R opencode:opencode /home/opencode/.local", web)

    def test_local_opencode_project_is_browsable_from_its_home_directory(self):
        dockerfile = (ROOT / "opencode/Dockerfile").read_text()
        compose = (ROOT / "docker-compose.local.yml").read_text()
        entry = (ROOT / "opencode/web-entry.mjs").read_text()
        self.assertIn("WORKDIR /home/opencode/workspace", dockerfile)
        self.assertIn(
            "./.local-harness/context:/home/opencode/workspace:ro",
            compose,
        )
        self.assertIn('CMD ["node", "/opt/opencode/web-entry.mjs"]', dockerfile)
        self.assertIn("Buffer.from(projectDirectory, \"utf8\").toString(\"base64url\")", entry)
        self.assertIn("location: projectRoute", entry)

    def test_opencode_login_uses_a_signed_24_hour_http_only_session(self):
        auth = (ROOT / "opencode/auth.mjs").read_text()
        entry = (ROOT / "opencode/web-entry.mjs").read_text()
        compose = (ROOT / "docker-compose.local.yml").read_text()
        self.assertIn("HttpOnly", auth)
        self.assertIn("SameSite=Lax", auth)
        self.assertIn("86400", entry)
        self.assertIn("timingSafeEqual", auth)
        self.assertIn("delete upstreamEnvironment.OPENCODE_SERVER_PASSWORD", entry)
        self.assertIn("OPENCODE_SESSION_SECRET", compose)

    def test_opencode_uses_headless_server_without_opening_a_browser(self):
        entry = (ROOT / "opencode/web-entry.mjs").read_text()
        self.assertIn('spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(upstreamPort)]', entry)
        self.assertNotIn('spawn("opencode", ["web",', entry)

    def test_secret_scan_covers_fine_grained_github_and_openai_keys(self):
        module = load_module("tests/test_repository_hygiene.py", "product_secret_patterns")
        self.assertTrue(hasattr(module, "SECRET_PATTERNS"))
        github_token = "github" + "_pat_" + "A" * 82
        openai_project_key = "sk" + "-proj-" + "A" * 80
        openai_legacy_key = "sk" + "-" + "B" * 48

        self.assertRegex(github_token.encode(), module.SECRET_PATTERNS["GitHub fine-grained PAT"])
        self.assertRegex(openai_project_key.encode(), module.SECRET_PATTERNS["OpenAI API key"])
        self.assertRegex(openai_legacy_key.encode(), module.SECRET_PATTERNS["OpenAI API key"])

    def test_agent_inventory_cannot_self_assert_attestation_success(self):
        contract = load_module(
            "skills/deploy-issue-harness-agent/scripts/agent_evidence_contract.py",
            "product_agent_evidence",
        ).AGENT_INVENTORY_CONTRACT
        observed = "2026-07-17T00:00:00+00:00"
        forged = {
            "inventoryVersion": 1,
            "inventoryId": "11111111-1111-4111-8111-111111111111",
            "source": "coolify-api",
            "observedAt": observed,
            "expiresAt": "2026-07-17T00:09:00+00:00",
            "applicationUuid": "agent-app",
            "serverUuid": "automation-server",
            "harnessImage": "ghcr.io/void0dev/issue-harness@sha256:" + "a" * 64,
            "opencodeWebImage": "ghcr.io/void0dev/opencode-web@sha256:" + "b" * 64,
            "dataDir": "/opt/issue-harness/acme-service",
            "replicas": 1,
            "rolloutHarnessImage": "ghcr.io/void0dev/issue-harness@sha256:" + "a" * 64,
            "rolloutOpenCodeWebImage": "ghcr.io/void0dev/opencode-web@sha256:" + "b" * 64,
            "rolloutStatus": "running",
            "harnessProvenanceVerified": True,
            "opencodeWebProvenanceVerified": True,
        }

        errors = contract.validate(forged)

        self.assertTrue(any("unsupported fields" in error for error in errors))

    def test_offline_attestation_verifier_binds_subject_source_workflow_ref_and_run(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "product_attestation_verifier",
        )
        self.assertTrue(hasattr(module, "verify_image_attestation"))
        self.assertTrue(hasattr(module, "shutil"))
        source_commit = "c" * 40
        source_ref = "refs/heads/main"
        publication_run_id = "123456789"
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            manifest = root / "manifest.json"
            manifest.write_bytes(b'{"schemaVersion":2}\n')
            digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
            subject = f"ghcr.io/void0dev/issue-harness@sha256:{digest}"
            bundle = root / "attestation.jsonl"
            bundle.write_text("signed bundle fixture")
            trusted_root = root / "trusted_root.jsonl"
            trusted_root.write_text("trusted root fixture")
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(
                    verification_result(subject, source_commit, source_ref, publication_run_id)
                ),
                stderr="",
            )

            with mock.patch.object(module.shutil, "which", return_value="/usr/bin/gh"), mock.patch.object(
                module.subprocess, "run", return_value=completed
            ) as verifier:
                errors = module.verify_image_attestation(
                    subject=subject,
                    manifest_path=manifest,
                    bundle_path=bundle,
                    trusted_root_path=trusted_root,
                    source_commit=source_commit,
                    source_ref=source_ref,
                    publication_run_id=publication_run_id,
                )

        self.assertEqual(errors, [])
        command = verifier.call_args.args[0]
        self.assertEqual(command[0:3], ["/usr/bin/gh", "attestation", "verify"])
        staged_directory = pathlib.Path(verifier.call_args.kwargs["cwd"])
        self.assertEqual(pathlib.Path(command[3]), staged_directory / "manifest.json")
        self.assertNotIn(str(manifest), command)
        for flag, value in (
            ("--repo", "Void0dev/harness"),
            ("--signer-workflow", "Void0dev/harness/.github/workflows/publish-images.yml"),
            ("--source-digest", source_commit),
            ("--source-ref", source_ref),
            ("--predicate-type", "https://slsa.dev/provenance/v1"),
            ("--format", "json"),
        ):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertEqual(
            pathlib.Path(command[command.index("--bundle") + 1]),
            staged_directory / "attestation-bundle.jsonl",
        )
        self.assertEqual(
            pathlib.Path(command[command.index("--custom-trusted-root") + 1]),
            staged_directory / "trusted-root.jsonl",
        )
        self.assertNotIn(str(bundle), command)
        self.assertNotIn(str(trusted_root), command)
        self.assertIn("--deny-self-hosted-runners", command)
        self.assertNotIn("oci://", " ".join(command))
        self.assertEqual(verifier.call_args.kwargs["timeout"], 30)
        self.assertFalse(verifier.call_args.kwargs["shell"])

    def test_forged_verifier_json_with_another_publication_run_fails_closed(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "product_attestation_forgery",
        )
        self.assertTrue(hasattr(module, "verify_image_attestation"))
        self.assertTrue(hasattr(module, "shutil"))
        source_commit = "c" * 40
        source_ref = "refs/heads/main"
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            manifest = root / "manifest.json"
            manifest.write_bytes(b'{"schemaVersion":2}\n')
            digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
            subject = f"ghcr.io/void0dev/issue-harness@sha256:{digest}"
            bundle = root / "attestation.jsonl"
            bundle.write_text("signed bundle fixture")
            trusted_root = root / "trusted_root.jsonl"
            trusted_root.write_text("trusted root fixture")
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(verification_result(subject, source_commit, source_ref, "999999999")),
                stderr="",
            )
            with mock.patch.object(module.shutil, "which", return_value="/usr/bin/gh"), mock.patch.object(
                module.subprocess, "run", return_value=completed
            ):
                errors = module.verify_image_attestation(
                    subject=subject,
                    manifest_path=manifest,
                    bundle_path=bundle,
                    trusted_root_path=trusted_root,
                    source_commit=source_commit,
                    source_ref=source_ref,
                    publication_run_id="123456789",
                )

        self.assertTrue(any("publication run" in error for error in errors))

    def test_attestation_verifier_accepts_only_main_publication_attestations(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "product_attestation_source_ref_policy",
        )

        self.assertIsNotNone(module.TRUSTED_SOURCE_REF.fullmatch("refs/heads/main"))
        for untrusted in (
            "refs/heads/feature",
            "refs/heads/release/v1.2.3",
            "refs/tags/release-1.2.3",
            "refs/tags/v1",
            "refs/tags/v1.2.3",
            "refs/tags/vbeta",
            "refs/tags/v1/unsafe",
        ):
            with self.subTest(untrusted=untrusted):
                self.assertIsNone(module.TRUSTED_SOURCE_REF.fullmatch(untrusted))

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            manifest = root / "manifest.json"
            manifest.write_bytes(b'{"schemaVersion":2}\n')
            digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
            subject = f"ghcr.io/void0dev/issue-harness@sha256:{digest}"
            bundle = root / "attestation.jsonl"
            bundle.write_text("signed bundle fixture")
            trusted_root = root / "trusted_root.jsonl"
            trusted_root.write_text("trusted root fixture")
            with mock.patch.object(module.shutil, "which", return_value="/usr/bin/gh"), mock.patch.object(
                module.subprocess, "run"
            ) as verifier:
                for untrusted in (
                    "refs/heads/feature",
                    "refs/tags/release-1.2.3",
                    "refs/tags/v1.2.3",
                    "refs/tags/vbeta",
                ):
                    with self.subTest(verifier_rejects=untrusted):
                        errors = module.verify_image_attestation(
                            subject=subject,
                            manifest_path=manifest,
                            bundle_path=bundle,
                            trusted_root_path=trusted_root,
                            source_commit="c" * 40,
                            source_ref=untrusted,
                            publication_run_id="123456789",
                        )
                        self.assertTrue(any("source ref" in error for error in errors))
                verifier.assert_not_called()

    def test_worker_activity_schema_is_exact_and_fresh(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "product_worker_activity_contract",
        )
        self.assertTrue(hasattr(module, "validate_worker_contract"))
        valid = json.loads((
            ROOT
            / "skills/deploy-issue-harness-agent/assets/contracts/worker-health-v1.healthy.json"
        ).read_text())
        now = datetime.datetime(2026, 7, 20, 10, 0, 1, tzinfo=datetime.timezone.utc)
        self.assertEqual(module.validate_worker_contract(valid, now=now), [])

        invalid_payloads = (
            {**valid, "extra": True},
            {**valid, "schemaVersion": 2},
            {**valid, "ageMs": True},
            {**valid, "activity": {"poll": "sleeping", "run": "running"}},
            {**valid, "activity": {"poll": "waiting", "run": "busy"}},
            {**valid, "activity": {"poll": "waiting", "run": "idle", "extra": True}},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                self.assertTrue(module.validate_worker_contract(payload, now=now))

    def test_attestation_verifier_stages_checked_bytes_before_gh_reopens_paths(self):
        module = load_module(
            "skills/deploy-issue-harness-agent/scripts/verify_agent.py",
            "product_attestation_staging",
        )
        source_commit = "c" * 40
        source_ref = "refs/heads/main"
        publication_run_id = "123456789"
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            originals = {
                "manifest": (root / "manifest.json", b'{"schemaVersion":2}\n'),
                "bundle": (root / "attestation.jsonl", b"signed bundle fixture"),
                "trusted_root": (root / "trusted_root.jsonl", b"trusted root fixture"),
            }
            for path, contents in originals.values():
                path.write_bytes(contents)
            manifest = originals["manifest"][0]
            digest = hashlib.sha256(originals["manifest"][1]).hexdigest()
            subject = f"ghcr.io/void0dev/issue-harness@sha256:{digest}"
            observed = {}

            def verifier(command, **kwargs):
                # Simulate an attacker replacing every operator-controlled pathname
                # after validation but before gh consumes its arguments.
                for path, _ in originals.values():
                    path.write_bytes(b"replaced after validation")
                staged = {
                    "manifest": pathlib.Path(command[3]),
                    "bundle": pathlib.Path(command[command.index("--bundle") + 1]),
                    "trusted_root": pathlib.Path(
                        command[command.index("--custom-trusted-root") + 1]
                    ),
                }
                observed["paths"] = staged
                observed["contents"] = {
                    name: path.read_bytes() for name, path in staged.items()
                }
                observed["modes"] = {
                    name: path.stat().st_mode & 0o777 for name, path in staged.items()
                }
                observed["directory_mode"] = pathlib.Path(kwargs["cwd"]).stat().st_mode & 0o777
                return subprocess.CompletedProcess(
                    args=command,
                    returncode=0,
                    stdout=json.dumps(
                        verification_result(
                            subject, source_commit, source_ref, publication_run_id
                        )
                    ),
                    stderr="",
                )

            with mock.patch.object(module.shutil, "which", return_value="/usr/bin/gh"), mock.patch.object(
                module.subprocess, "run", side_effect=verifier
            ):
                errors = module.verify_image_attestation(
                    subject=subject,
                    manifest_path=manifest,
                    bundle_path=originals["bundle"][0],
                    trusted_root_path=originals["trusted_root"][0],
                    source_commit=source_commit,
                    source_ref=source_ref,
                    publication_run_id=publication_run_id,
                )

        self.assertEqual(errors, [])
        self.assertEqual(observed["directory_mode"], 0o700)
        self.assertEqual(observed["modes"], {name: 0o600 for name in originals})
        self.assertEqual(
            observed["contents"],
            {name: contents for name, (_, contents) in originals.items()},
        )
        for name, staged_path in observed["paths"].items():
            self.assertNotEqual(staged_path, originals[name][0])

    def test_every_dockerfile_base_stage_is_digest_pinned(self):
        dockerfiles = (
            ROOT / "services" / "issue-harness" / "Dockerfile",
            ROOT / "opencode" / "Dockerfile",
        )
        for dockerfile in dockerfiles:
            for line in dockerfile.read_text().splitlines():
                if line.startswith("FROM "):
                    with self.subTest(dockerfile=dockerfile, line=line):
                        self.assertRegex(line, r"^FROM [^\s]+@sha256:[0-9a-f]{64}(?: AS [a-z0-9_-]+)?$")

    def test_inventory_generators_emit_fresh_exact_hybrid_and_agent_shapes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            hybrid_values = {
                "source": "coolify-api",
                "applications": [
                    {
                        "applicationUuid": "app-stage",
                        "projectUuid": "project",
                        "serverUuid": "server",
                        "environmentName": "stage",
                        "name": "service-stage",
                        "repository": "acme/service",
                        "branch": "stage",
                        "domain": "https://stage.example.test",
                    },
                    {
                        "applicationUuid": "app-production",
                        "projectUuid": "project",
                        "serverUuid": "server",
                        "environmentName": "production",
                        "name": "service-production",
                        "repository": "acme/service",
                        "branch": "main",
                        "domain": "https://example.test",
                    },
                ],
                "databases": [
                    {
                        "databaseUuid": f"postgres-{lane}",
                        "databaseType": "postgresql",
                        "projectUuid": "project",
                        "serverUuid": "server",
                        "environmentName": lane,
                        "ready": True,
                        "readinessSource": "coolify-health",
                    }
                    for lane in ("stage", "production")
                ],
                "convexDeployments": [
                    {
                        "capabilityId": "convex",
                        "lane": lane,
                        "projectRef": f"convex-project-{lane}",
                        "deploymentRef": f"convex-deployment-{lane}",
                        "deploymentType": "permanent",
                        "deployKeyRef": f"{lane.upper()}_CONVEX_DEPLOY_KEY",
                        "deployKeyScope": f"convex-deployment-{lane}",
                        "ready": True,
                        "readinessSource": "convex-deployment",
                    }
                    for lane in ("stage", "production")
                ],
                "deliveryEnvironments": [
                    {
                        "lane": lane,
                        "environmentName": lane,
                        "branch": "stage" if lane == "stage" else "main",
                        "credentialScope": f"github-environment:{lane}",
                        "requiredReviewers": 0 if lane == "stage" else 1,
                        "preventSelfReview": lane == "production",
                    }
                    for lane in ("stage", "production")
                ],
                "environmentVariables": [],
            }
            hybrid_input = root / "hybrid-values.json"
            hybrid_input.write_text(json.dumps(hybrid_values))
            generated = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "skills/setup-coolify-cicd/scripts/generate_inventory_fixture.py"),
                    "--profile",
                    "hybrid",
                    "--values-json",
                    str(hybrid_input),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(generated.returncode, 0, generated.stderr + generated.stdout)
            hybrid = json.loads(generated.stdout)
            self.assertEqual(hybrid["inventoryVersion"], 1)
            self.assertIn("inventoryId", hybrid)
            self.assertIn("expiresAt", hybrid)
            evidence = load_module(
                "skills/setup-coolify-cicd/harness_evidence.py", "product_hybrid_evidence"
            )
            self.assertEqual(evidence.validate_coolify_inventory(hybrid), [])

            agent_values = {
                "source": "coolify-api",
                "applicationUuid": "agent-app",
                "serverUuid": "automation-server",
                "harnessImage": "ghcr.io/void0dev/issue-harness@sha256:" + "a" * 64,
                "opencodeWebImage": "ghcr.io/void0dev/opencode-web@sha256:" + "b" * 64,
                "dataDir": "/opt/issue-harness/acme-service",
                "replicas": 1,
                "rolloutHarnessImage": "ghcr.io/void0dev/issue-harness@sha256:" + "a" * 64,
                "rolloutOpenCodeWebImage": "ghcr.io/void0dev/opencode-web@sha256:" + "b" * 64,
                "rolloutStatus": "running",
            }
            agent_input = root / "agent-values.json"
            agent_input.write_text(json.dumps(agent_values))
            generated_agent = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "skills/deploy-issue-harness-agent/scripts/generate_agent_inventory_fixture.py"),
                    "--values-json",
                    str(agent_input),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(
                generated_agent.returncode, 0, generated_agent.stderr + generated_agent.stdout
            )
            agent = json.loads(generated_agent.stdout)
            self.assertNotIn("harnessProvenanceVerified", agent)
            self.assertEqual(set(agent), set(agent_values) | {
                "inventoryVersion", "inventoryId", "observedAt", "expiresAt"
            })

    def test_inventory_value_templates_are_redacted_and_cover_every_profile(self):
        templates = {
            "skills/setup-coolify-cicd/assets/inventory-values/application.values.example.json": (),
            "skills/setup-coolify-cicd/assets/inventory-values/nest-postgres.values.example.json": ("databases",),
            "skills/setup-coolify-cicd/assets/inventory-values/convex.values.example.json": ("convexDeployments",),
            "skills/setup-coolify-cicd/assets/inventory-values/hybrid.values.example.json": ("databases", "convexDeployments"),
            "skills/deploy-issue-harness-agent/assets/inventory-values/agent-rollout.values.example.json": ("rolloutHarnessImage",),
            "skills/deploy-issue-harness-agent/assets/inventory-values/provenance-verification.values.example.json": ("trustedRoot", "sourceRef"),
        }
        for relative, markers in templates.items():
            with self.subTest(template=relative):
                path = ROOT / relative
                self.assertTrue(path.is_file())
                payload = json.loads(path.read_text())
                self.assertNotIn("inventoryId", payload)
                self.assertNotIn("observedAt", payload)
                self.assertNotIn("expiresAt", payload)
                self.assertIn(None, str(payload) and list(_walk_values(payload)))
                for marker in markers:
                    self.assertIn(marker, payload)

    def test_product_docs_match_opencode_publisher_compiler_and_inventory_contracts(self):
        readme = (ROOT / "README.md").read_text()
        deploy_skill = (ROOT / "skills/deploy-issue-harness-agent/SKILL.md").read_text()
        agent_contract = (
            ROOT / "skills/deploy-issue-harness-agent/references/agent-contract.md"
        ).read_text()
        image_release = (
            ROOT / "skills/deploy-issue-harness-agent/references/image-release.md"
        ).read_text()
        setup_skill = (ROOT / "skills/setup-coolify-cicd/SKILL.md").read_text()
        readiness = (
            ROOT / "skills/setup-coolify-cicd/references/readiness-contract.md"
        ).read_text()

        for stale in (
            "Host Docker socket",
            "получает Docker socket",
            "Размещать raw-Docker-socket harness",
            "Codex subscription или API-key auth",
            "CODEX_AUTH_MODE` | `subscription` или `api-key`",
            "Listener push'ит ветку",
        ):
            self.assertNotIn(stale, readme)
        self.assertNotIn("broker jwt", readme.lower())
        self.assertIn("content-addressed", readme)
        self.assertIn("trusted publisher", readme)
        self.assertIn("npm run lint", readme)
        self.assertIn("schema v2", readme.lower())
        self.assertIn("generate_inventory_fixture.py", readme)
        self.assertIn("generate_agent_inventory_fixture.py", readme)

        for document in (deploy_skill, agent_contract):
            self.assertNotIn("OPENCODE_AUTH_MODE=broker", document)
            self.assertNotIn("SANDBOX_NETWORK", document)
            self.assertIn("trusted publisher", document)
        for flag in (
            "--bundle",
            "--custom-trusted-root",
            "--signer-workflow",
            "--source-digest",
            "--source-ref",
            "--deny-self-hosted-runners",
        ):
            self.assertIn(flag, image_release)
        self.assertIn("OCI manifest", image_release)
        self.assertIn("publication run", image_release)
        self.assertIn("node:22-bookworm@sha256:5647be709086", image_release)
        self.assertIn("refs/heads/main", image_release)
        self.assertNotIn("published from `refs/tags/", image_release)
        self.assertIn("alias", image_release.lower())
        self.assertIn("existing main-built digest", image_release)

        self.assertIn("externalAccess", setup_skill)
        self.assertIn("generate_inventory_fixture.py", setup_skill)
        self.assertIn("crash-recovery journal", setup_skill)
        self.assertIn("operator assertion", setup_skill)
        self.assertIn("schema v2", readiness.lower())
        self.assertNotIn("issue-agent rollout/provenance evidence", readiness)

        for fragment in ("convex-delivery-jobs.yml", "nest-migration-jobs.yml"):
            text = (ROOT / "skills/setup-coolify-cicd/assets" / fragment).read_text()
            self.assertIn("internal", text)
            self.assertIn("compiler", text)
            self.assertNotIn("Merge these jobs", text)

    def test_delivery_docs_use_immutable_attested_evidence_lifecycle(self):
        documents = {
            "readme": (ROOT / "README.md").read_text(),
            "skill": (ROOT / "skills/setup-coolify-cicd/SKILL.md").read_text(),
            "readiness": (
                ROOT / "skills/setup-coolify-cicd/references/readiness-contract.md"
            ).read_text(),
            "coolify": (
                ROOT / "skills/setup-coolify-cicd/references/coolify-api.md"
            ).read_text(),
        }
        combined = "\n".join(documents.values())
        for required in (
            "six canonical workflows",
            "runId",
            "artifactId",
            "GitHub attestation",
            "deployment-success-v1",
            "backend-release-v1",
            "consumption-v1",
            "bootstrap",
            "retention",
        ):
            self.assertIn(required, combined)
        for stale in (
            "оба compiler-generated workflow",
            "both generated workflows",
            "durably record the prior verified revision",
            "read and durably record the current full revision",
            "--rollback-ref",
        ):
            self.assertNotIn(stale, combined)
        self.assertIn("no raw revision", combined.lower())
        self.assertIn("expired", combined.lower())
        self.assertIn("performs no mutation", combined.lower())
        self.assertIn("normal delivery remains blocked", combined.lower())


def _walk_values(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_values(child)
    else:
        yield value


if __name__ == "__main__":
    unittest.main()
