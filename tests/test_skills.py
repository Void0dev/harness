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
        / "skills/deploy-opencode-harness/assets/contracts/worker-health-v1.healthy.json"
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
        "project": {"github": "acme/service"},
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


class SkillScriptsTest(unittest.TestCase):
    def test_deploy_skill_verifiers_run_from_a_standalone_packaged_copy(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        package_root = root / "standalone-deploy-skill"
        shutil.copytree(ROOT / "skills" / "deploy-opencode-harness", package_root)
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


    def test_typed_agent_evidence_contract_is_owned_by_the_standalone_agent_verifier(self):
        verifier = load_module(
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
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
                "skills/deploy-opencode-harness/scripts/verify_agent.py",
                (root, "--offline"),
            ),
            (
                "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
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
                self.assertIn("schemaVersion must be the integer 1", result.stderr)


    def test_repository_exposes_one_installable_harness_skill_with_all_runtime_assets(self):
        skill_names = sorted(
            path.name for path in (ROOT / "skills").iterdir()
            if path.is_dir() and (path / "SKILL.md").is_file()
        )
        self.assertEqual(skill_names, ["deploy-opencode-harness"])

        harness_skill = ROOT / "skills" / "deploy-opencode-harness"
        for relative in (
            "agents/openai.yaml",
            "scripts/agent_evidence_contract.py",
            "scripts/harness_config.py",
            "scripts/verify_agent.py",
            "scripts/verify_diagnostics.py",
            "scripts/github_labels.py",
            "scripts/generate_agent_inventory_fixture.py",
            "scripts/github_app_verifier.py",
            "scripts/github_branches.py",
            "scripts/github_rulesets.py",
            "scripts/installer_state.py",
            "assets/config.example.json",
            "assets/harness-compose.yml",
            "assets/release-app-registration.md",
            "assets/installation-result.example.txt",
            "assets/agent-task.yml",
            "assets/production-incident.yml",
            "assets/prompt.md",
            "assets/contracts/worker-health-v1.healthy.json",
            "assets/contracts/worker-health-v1.schema.json",
            "assets/inventory-values/agent-rollout.values.example.json",
            "assets/inventory-values/provenance-verification.values.example.json",
            "references/agent-contract.md",
            "references/image-release.md",
            "references/production-diagnostics.md",
        ):
            self.assertTrue((harness_skill / relative).is_file(), relative)
        release_contract = (harness_skill / "references" / "image-release.md").read_text()
        self.assertIn("https://github.com/Void0dev/harness", release_contract)
        self.assertIn("ghcr.io/void0dev/issue-harness@sha256:", release_contract)
        self.assertIn("ghcr.io/void0dev/opencode-web@sha256:", release_contract)

        self.assertFalse((ROOT / "skills" / "deploy-issue-harness-agent").exists())


    def test_installation_skill_is_capability_driven_and_provider_agnostic(self):
        skill = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")

        self.assertIn("capabilit", skill.lower())
        self.assertIn("OpenCode", skill)
        self.assertIn("обычный issue flow", skill.lower())
        self.assertIn("Никогда не читай и не меняй target application", skill)
        self.assertNotIn("OPENCODE_AUTH_MODE=broker", skill)
        self.assertNotIn("SANDBOX_NETWORK", skill)
        self.assertNotIn("CODEX_", skill)
        self.assertNotIn("provider support", skill.lower())
        self.assertNotIn("## Coolify command profiles", skill)
        self.assertNotRegex(skill, r"(?m)^### Coolify ")
        self.assertNotIn("coolify_environment_url", skill)
        self.assertNotIn("coolify_token_env_path", skill)
        self.assertNotIn("COOLIFY_TOKEN", skill)
        for capability in (
            "bounded command execution",
            "deployment artifact materialization",
            "persistent storage",
            "secret storage/rotation",
            "one public HTTPS route",
            "private Harness-to-runtime probe",
        ):
            self.assertIn(capability, skill)


    def test_skill_uses_one_time_secret_reads_and_never_requests_pem_contents(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("прочитай App ID/PEM один раз", addon)
        self.assertIn("Никогда не проси вставлять PEM contents", addon)
        self.assertIn("GITHUB_APP_INSTALLATION_ID", addon)
        self.assertIn("github_app_verifier.py", addon)


    def test_skill_derives_repository_and_generates_exact_release_app_instructions(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")
        instructions = (ROOT / "skills/deploy-opencode-harness/assets/release-app-registration.md").read_text()
        self.assertIn("текущего checkout", addon)
        self.assertIn("`main`", addon)
        self.assertIn("`stage`", addon)
        self.assertIn("Metadata", addon)
        self.assertIn("Contents: read/write", addon)
        self.assertIn("Checks: read-only", addon)
        self.assertIn("Administration", addon)
        self.assertIn("only the target repository", addon)
        self.assertIn("{{REPOSITORY}}", instructions)
        self.assertIn("{{APP_NAME}}", instructions)
        self.assertIn("Only select repositories", instructions)


    def test_skill_requires_manual_release_app_checkpoint_before_mutation(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")

        self.assertIn("Release App", addon)
        self.assertIn("manual", addon.lower())
        self.assertIn("checkpoint", addon.lower())
        self.assertRegex(addon, r"(?is)Release App.{0,1000}(?:останов|дожд)" )


    def test_skill_discovers_capabilities_without_reading_target_resources(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")

        self.assertIn("discover access", addon.lower())
        self.assertIn("target application", addon.lower())
        self.assertNotIn("chat_domain:", addon)
        self.assertIn("не перечисляй providers", addon)


    def test_skill_generates_credentials_once_and_persists_only_opaque_references(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")

        self.assertIn("Сгенерируй один раз strong web login/password", addon)
        self.assertIn("только opaque references", addon)
        self.assertIn("0700/0600", addon)


    def test_skill_uses_any_available_server_access_without_a_provider_matrix(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("любые уже доступные server credentials", addon)
        self.assertIn("любой рабочий способ доступа", addon)
        self.assertNotIn("supported providers", addon.lower())
        self.assertNotRegex(addon, r"(?m)^\s*[-*]\s+(?:Coolify|SSH|Kubernetes|Docker):")


    def test_skill_result_is_exactly_url_login_and_password(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")

        result = addon.split("## Result contract", 1)[1].split("\n## ", 1)[0]
        fields = re.findall(r"(?m)^([a-z]+): <", result)
        self.assertEqual(fields, ["url", "login", "password"])
        self.assertIn("exactly", result.lower())


    def test_skill_states_resume_idempotence_and_security_invariants(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")

        for heading in ("## Resume invariants", "## Idempotence invariants", "## Security invariants"):
            self.assertIn(heading, addon)
        self.assertIn("persisted", addon.lower())
        self.assertIn("same harness", addon.lower())
        self.assertIn("never print", addon.lower())
        self.assertIn("Never call DELETE", addon)
        for phase in (
            "preflight",
            "awaiting-github-app",
            "github-app-verified",
            "branches-verified",
            "awaiting-ruleset-authority",
            "rulesets-verified",
            "deployed",
            "verified",
            "reported",
        ):
            self.assertIn(phase, addon)


    def test_skill_renders_the_runtime_only_model_key_config(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")
        compose = (ROOT / "coolify/harness.production.compose.yml").read_text()

        self.assertIn("__VOID_AI_API_KEY_AT_DEPLOY__", addon)
        self.assertIn("replace the marker only in memory", addon)
        self.assertIn("Never store `VOID_AI_API_KEY` as a Service environment variable", addon)
        self.assertIn("SERVICE_FQDN_HARNESS_4096: /", compose)
        self.assertIn("assets/harness-compose.yml", addon)
        self.assertIn("публичный `harness`", addon)
        self.assertIn("приватный `opencode-runtime`", addon)


    def test_skill_defines_draft_pr_default_and_explicit_merge_lanes(self):
        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("draft PR", addon)
        self.assertIn("не запускает merge автоматически", addon)
        for command in ("/merge stage", "/merge stage #<issue>", "/merge prod"):
            self.assertIn(command, addon)
        self.assertIn("PR `stage -> main`", addon)
        self.assertIn("никогда не мержится прямо в `main`", addon)


    def test_harness_runtime_uses_only_github_app_credentials(self):
        runtime_files = [
            ROOT / ".env.example",
            ROOT / "docker-compose.local.yml",
            ROOT / "coolify/docker-compose.yml",
            ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml",
            ROOT / "skills/deploy-opencode-harness/references/agent-contract.md",
            ROOT / "skills/deploy-opencode-harness/SKILL.md",
        ]
        for path in runtime_files:
            content = path.read_text()
            self.assertNotIn("GITHUB_TOKEN", content, str(path))
            self.assertIn("GITHUB_APP_ID", content, str(path))
            self.assertIn("GITHUB_APP_INSTALLATION_ID", content, str(path))

        addon = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()
        self.assertIn("App ID", addon)
        self.assertIn("GITHUB_APP_INSTALLATION_ID", addon)

        for relative in (
            "docker-compose.local.yml",
            "coolify/docker-compose.yml",
            "skills/deploy-opencode-harness/assets/harness-compose.yml",
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
        (root / ".github" / "ISSUE_TEMPLATE").mkdir(parents=True)
        (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").write_text("name: Agent task\n")
        return temporary, root


    def test_label_plan_uses_runtime_contract(self):
        result = run_script("skills/deploy-opencode-harness/scripts/github_labels.py", "acme/service", "plan")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        names = [item["name"] for item in json.loads(result.stdout)["labels"]]
        self.assertEqual(names, ["ai:backlog", "ai:todo", "ai:running", "ai:finished", "ai:needs-human", "production:diagnose"])


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
            "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
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
            "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
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
            "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
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
            "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
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
            "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
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
        agent = run_script("skills/deploy-opencode-harness/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(agent.returncode, 0, agent.stderr + agent.stdout)


    def test_agent_validator_rejects_missing_repository_assets(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").unlink()
        payload = config()
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-opencode-harness/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(any("agent-task.yml" in error for error in report["errors"]))


    def test_agent_validator_rejects_floating_opencode_image(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["opencodeWebImage"] = "opencode-web:latest"
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-opencode-harness/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertTrue(any("sha256" in item for item in report["errors"]))


    def test_agent_validator_rejects_forked_image_coordinates_even_with_a_digest(self):
        temporary, root = self.fixture()
        self.addCleanup(temporary.cleanup)
        payload = config()
        payload["issueAgent"]["harnessImage"] = "ghcr.io/attacker/issue-harness@sha256:" + "a" * 64
        (root / ".harness" / "config.json").write_text(json.dumps(payload))
        result = run_script("skills/deploy-opencode-harness/scripts/verify_agent.py", root, "--offline")
        self.assertEqual(result.returncode, 1)
        self.assertIn("canonical coordinate", result.stdout)


    def test_agent_inventory_proves_rollout_refs_but_cannot_assert_provenance(self):
        module = load_module(
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
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
        result = run_script("skills/deploy-opencode-harness/scripts/verify_agent.py", root, "--offline")
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
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
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
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
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
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
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
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
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
