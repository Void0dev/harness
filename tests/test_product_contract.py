import importlib.util
import pathlib
import subprocess
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(relative: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ProductContractTest(unittest.TestCase):
    def test_repository_has_no_legacy_convex_demo_runtime(self):
        package = (ROOT / "package.json").read_text()
        compose = (ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml").read_text()
        environment = (ROOT / ".env.example").read_text()
        tracked = subprocess.run(
            ["git", "ls-files", "apps/convex-demo"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(tracked.returncode, 0, tracked.stderr)
        self.assertEqual(tracked.stdout, "")
        self.assertNotIn("convex-demo", package)
        self.assertNotIn("convex-demo", compose)
        self.assertNotIn("VITE_CONVEX_URL", environment)

    def test_issue_harness_dockerfile_does_not_embed_a_sandbox_runtime(self):
        dockerfile = (ROOT / "services/issue-harness/Dockerfile").read_text()
        self.assertNotIn("docker.io", dockerfile)
        self.assertNotIn("docker-cli", dockerfile)
        self.assertNotIn("opencode-ai", dockerfile)
        self.assertNotIn("/data/artifacts", dockerfile)
        self.assertNotIn("/data/logs", dockerfile)
        self.assertNotIn("/data/publishers", dockerfile)

    def test_opencode_child_sessions_replace_sandcastle_and_model_broker(self):
        package = (ROOT / "services/issue-harness/package.json").read_text()
        compose = (ROOT / "docker-compose.local.yml").read_text()
        runner = (ROOT / "services/issue-harness/src/runner.ts").read_text()
        publication = (ROOT / ".github/workflows/publish-images.yml").read_text()
        self.assertNotIn("@ai-hero/sandcastle", package)
        self.assertNotIn("model-broker", compose)
        self.assertNotIn("SANDBOX_", compose)
        self.assertNotIn("sandcastle-harness", publication)
        self.assertIn("client.createChild", runner)
        self.assertIn("client.continueSession", runner)

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

    def test_linux_images_create_private_shared_runtime_state(self):
        harness = (ROOT / "services/issue-harness/Dockerfile").read_text()
        web = (ROOT / "opencode/Dockerfile").read_text()
        self.assertIn("sed -i 's/\\r$//'", harness)
        self.assertIn("/home/opencode/.local/state", web)
        self.assertIn("install -d -o opencode -g harness-shared -m 0700", web)
        self.assertIn("install -d -o agent -g harness-shared -m 2770", harness)

    def test_opencode_project_is_a_writable_repository_workspace(self):
        dockerfile = (ROOT / "opencode/Dockerfile").read_text()
        compose = (ROOT / "docker-compose.local.yml").read_text()
        entry = (ROOT / "opencode/web-entry.mjs").read_text()
        self.assertIn("WORKDIR /home/opencode/workspace", dockerfile)
        self.assertIn("./.local-harness/context:/home/opencode/workspace", compose)
        self.assertNotIn("./.local-harness/context:/home/opencode/workspace:ro", compose)
        self.assertIn("Buffer.from(projectDirectory, \"utf8\").toString(\"base64url\")", entry)

    def test_opencode_login_uses_a_signed_24_hour_http_only_session(self):
        auth = (ROOT / "opencode/auth.mjs").read_text()
        gateway = (ROOT / "opencode/lib/public-gateway.mjs").read_text()
        compose = (ROOT / "docker-compose.local.yml").read_text()
        self.assertIn("HttpOnly", auth)
        self.assertIn("SameSite=Lax", auth)
        self.assertIn("86_400", gateway)
        self.assertIn("timingSafeEqual", auth)
        self.assertIn("OPENCODE_SESSION_SECRET", compose)

    def test_opencode_uses_headless_server_without_opening_a_browser(self):
        entry = (ROOT / "opencode/web-entry.mjs").read_text()
        self.assertIn('spawn("opencode", ["serve", "--hostname", "127.0.0.1"', entry)
        self.assertNotIn('spawn("opencode", ["web",', entry)

    def test_production_runtime_is_non_root_private_digest_based_and_two_service(self):
        compose = (ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml").read_text()
        worker = (ROOT / "services/issue-harness/Dockerfile").read_text()
        web = compose.split("  opencode-runtime:", 1)[1]
        harness = compose.split("  harness:", 1)[1].split("  opencode-runtime:", 1)[0]
        self.assertIn("USER agent", worker)
        self.assertNotIn("SERVICE_FQDN_", compose)
        self.assertNotIn("docker.sock", compose)
        self.assertNotIn("privileged:", compose)
        self.assertIn("cap_drop:\n      - ALL", compose)
        self.assertNotIn("build:", compose)
        self.assertIn("image: ${HARNESS_IMAGE:?set an immutable harness image digest}", harness)
        self.assertIn("image: ${OPENCODE_WEB_IMAGE:?set an immutable OpenCode Web image digest}", web)

    def test_model_key_is_runtime_only_in_every_compose(self):
        for relative in (
            "docker-compose.local.yml",
            "skills/deploy-opencode-harness/assets/harness-compose.yml",
        ):
            with self.subTest(compose=relative):
                compose = (ROOT / relative).read_text()
                harness = compose.split("  harness:", 1)[1].split("  opencode-runtime:", 1)[0]
                runtime = compose.split("  opencode-runtime:", 1)[1]
                self.assertNotIn("VOID_AI_API_KEY", harness)
                self.assertIn("VOID_AI_API_KEY_FILE", runtime)

    def test_secret_scan_covers_fine_grained_github_and_openai_keys(self):
        module = load_module("tests/test_repository_hygiene.py", "product_secret_patterns")
        github_token = "github" + "_pat_" + "A" * 82
        openai_project_key = "sk" + "-proj-" + "A" * 80
        openai_legacy_key = "sk" + "-" + "B" * 48
        self.assertRegex(github_token.encode(), module.SECRET_PATTERNS["GitHub fine-grained PAT"])
        self.assertRegex(openai_project_key.encode(), module.SECRET_PATTERNS["OpenAI API key"])
        self.assertRegex(openai_legacy_key.encode(), module.SECRET_PATTERNS["OpenAI API key"])

    def test_every_dockerfile_base_stage_is_digest_pinned(self):
        for dockerfile in (
            ROOT / "services/issue-harness/Dockerfile",
            ROOT / "opencode/Dockerfile",
        ):
            for line in dockerfile.read_text().splitlines():
                if line.startswith("FROM "):
                    self.assertRegex(line, r"^FROM [^\s]+@sha256:[0-9a-f]{64}(?: AS [a-z0-9_-]+)?$")

    def test_product_contract_uses_agent_owned_git_publication_and_standard_merge(self):
        readme = (ROOT / "README.md").read_text()
        skill = (ROOT / "skills/deploy-opencode-harness/SKILL.md").read_text()
        contract = (ROOT / "skills/deploy-opencode-harness/references/agent-contract.md").read_text()
        worker_prompt = (ROOT / "services/issue-harness/src/worker-prompt.ts").read_text()
        combined = skill + "\n" + contract

        self.assertIn("harness-github git push", worker_prompt)
        self.assertIn("harness-github gh pr create", worker_prompt)
        self.assertIn("--draft", worker_prompt)
        self.assertIn("standard OpenCode", combined)
        self.assertIn("standard `build` agent", readme)
        for stale in (
            "release agent",
            "trusted publisher",
            "content-addressed artifact",
            "productionAgent",
            "production diagnostics",
        ):
            self.assertNotIn(stale, combined)
            self.assertNotIn(stale, readme)

    def test_removed_deployment_subsystems_are_absent(self):
        stale = (
            "skills/deploy-opencode-harness/scripts/verify_agent.py",
            "skills/deploy-opencode-harness/scripts/verify_diagnostics.py",
            "skills/deploy-opencode-harness/scripts/agent_evidence_contract.py",
            "skills/deploy-opencode-harness/scripts/generate_agent_inventory_fixture.py",
            "skills/deploy-opencode-harness/scripts/github_labels.py",
            "skills/deploy-opencode-harness/scripts/harness_config.py",
            "skills/deploy-opencode-harness/assets/config.example.json",
            "skills/deploy-opencode-harness/assets/agent-task.yml",
            "skills/deploy-opencode-harness/assets/production-incident.yml",
            "skills/deploy-opencode-harness/references/production-diagnostics.md",
            "coolify/docker-compose.yml",
            "coolify/harness.production.compose.yml",
            "services/issue-harness/github_app_secret.sh",
        )
        for relative in stale:
            self.assertFalse((ROOT / relative).exists(), relative)

    def test_private_runtime_has_no_legacy_login_or_unused_release_state(self):
        runtime = (ROOT / "opencode/web-entry.mjs").read_text()
        runtime_auth = (ROOT / "opencode/lib/runtime-auth.mjs").read_text()
        state = (ROOT / "services/issue-harness/src/state.ts").read_text()
        runner = (ROOT / "services/issue-harness/src/runner.ts").read_text()
        security = (ROOT / "services/issue-harness/src/security.ts").read_text()
        compose = (ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml").read_text()

        for stale in (
            "OPENCODE_RUNTIME_MODE",
            "createSessionCookie",
            "parseSessionCookie",
            "credentialsMatch",
            "loginPage",
        ):
            self.assertNotIn(stale, runtime)
            self.assertNotIn(stale, runtime_auth)
        for stale in ("prNumber", "prHeadSha"):
            self.assertNotIn(stale, state)
        self.assertNotIn("export async function runAgent", runner)
        self.assertNotIn("export { buildIssuePrompt }", runner)
        self.assertNotIn("redactForGithub", security)
        self.assertNotIn("publicHarnessStatus", security)
        self.assertNotIn("VOID_AI_MODEL_ID", compose.split("  opencode-runtime:", 1)[1])

    def test_declared_test_command_includes_opencode_suite(self):
        package = (ROOT / "package.json").read_text()
        self.assertIn('"test:opencode": "node --test opencode/test/*.test.mjs"', package)
        self.assertIn("npm run test:opencode", package)

    def test_recovery_failures_are_reported(self):
        source = (ROOT / "services/issue-harness/src/index.ts").read_text()
        self.assertIn('console.error("Persisted session failure recovery failed", error)', source)

    def test_image_release_contract_uses_direct_github_attestation_verification(self):
        release = (ROOT / "skills/deploy-opencode-harness/references/image-release.md").read_text()
        self.assertIn("gh attestation verify oci://", release)
        self.assertIn("--repo Void0dev/harness", release)
        self.assertIn("--source-ref refs/heads/main", release)
        self.assertIn("--deny-self-hosted-runners", release)
        self.assertNotIn("verify_agent.py", release)
        self.assertNotIn("Coolify inventory", release)


if __name__ == "__main__":
    unittest.main()
