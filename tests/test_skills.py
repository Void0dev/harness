import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "deploy-opencode-harness"


class SkillContractTest(unittest.TestCase):
    def test_repository_exposes_one_installable_harness_skill_with_minimal_assets(self):
        skill_names = sorted(
            path.name for path in (ROOT / "skills").iterdir()
            if path.is_dir() and (path / "SKILL.md").is_file()
        )
        self.assertEqual(skill_names, ["deploy-opencode-harness"])

        required = (
            "SKILL.md",
            "agents/openai.yaml",
            "scripts/github_app_verifier.py",
            "scripts/github_branches.py",
            "scripts/github_rulesets.py",
            "scripts/installer_state.py",
            "assets/harness-compose.yml",
            "assets/release-app-registration.md",
            "assets/contracts/worker-health-v1.healthy.json",
            "assets/contracts/worker-health-v1.schema.json",
            "references/agent-contract.md",
            "references/image-release.md",
        )
        for relative in required:
            with self.subTest(required=relative):
                self.assertTrue((SKILL / relative).is_file())

        removed = (
            "scripts/agent_evidence_contract.py",
            "scripts/generate_agent_inventory_fixture.py",
            "scripts/github_labels.py",
            "scripts/harness_config.py",
            "scripts/verify_agent.py",
            "scripts/verify_diagnostics.py",
            "assets/agent-task.yml",
            "assets/config.example.json",
            "assets/installation-result.example.txt",
            "assets/production-incident.yml",
            "assets/prompt.md",
            "assets/inventory-values",
            "references/production-diagnostics.md",
        )
        for relative in removed:
            with self.subTest(removed=relative):
                self.assertFalse((SKILL / relative).exists())

    def test_installation_skill_is_capability_driven_and_provider_agnostic(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("capabilit", skill.lower())
        self.assertIn("любые уже доступные server credentials", skill)
        self.assertIn("любой рабочий способ доступа", skill)
        self.assertIn("не перечисляй providers", skill)
        self.assertIn("Никогда не читай и не меняй target application", skill)
        for capability in (
            "bounded command execution",
            "deployment definition materialization",
            "persistent storage",
            "secret storage/rotation",
            "one public HTTPS route",
            "private Harness-to-runtime probe",
        ):
            self.assertIn(capability, skill)
        for stale in (
            "COOLIFY_TOKEN",
            "productionAgent",
            "production diagnostics",
            "agent inventory",
            "verify_agent.py",
            "verify_diagnostics.py",
        ):
            self.assertNotIn(stale, skill)

    def test_skill_generates_credentials_once_and_persists_only_opaque_references(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("Сгенерируй один раз strong web login/password", skill)
        self.assertIn("только opaque references", skill)
        self.assertIn("0700/0600", skill)

    def test_skill_uses_one_time_secret_reads_and_never_requests_pem_contents(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("прочитай App ID, Installation ID, owner, repository, base branch и PEM один раз", skill)
        self.assertIn("Никогда не проси вставлять PEM contents в чат", skill)
        self.assertIn("локальный путь или secret reference", skill)
        self.assertNotRegex(skill, re.compile(r"paste.+pem", re.I | re.S))

    def test_skill_derives_repository_and_generates_exact_release_app_instructions(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        registration = (SKILL / "assets" / "release-app-registration.md").read_text()

        self.assertIn("owner/repository", skill)
        self.assertIn("<repo>-release-app", skill)
        for permission in (
            "Metadata: read-only",
            "Contents: read/write",
            "Issues: read/write",
            "Pull requests: read/write",
            "Checks: read-only",
            "Administration: disabled",
        ):
            self.assertIn(permission, skill)
        self.assertIn("Only select repositories", registration)
        self.assertIn("webhook", registration.lower())

    def test_skill_returns_owner_specific_clickable_github_app_links(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        registration = (SKILL / "assets" / "release-app-registration.md").read_text()

        self.assertIn("https://github.com/organizations/<owner>/settings/apps/new", skill)
        self.assertIn("https://github.com/settings/apps/new", skill)
        self.assertIn("Markdown-ссылки", skill)
        self.assertIn("{{CREATE_APP_URL}}", registration)
        self.assertIn("{{APPS_SETTINGS_URL}}", registration)

    def test_skill_requires_manual_release_app_checkpoint_before_mutation(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        checkpoint = skill.index("## Phase 2: manual Release App checkpoint")
        verification = skill.index("scripts/github_app_verifier.py")
        deployment = skill.index("## Phase 4: deploy or reconcile")
        self.assertLess(checkpoint, verification)
        self.assertLess(verification, deployment)
        self.assertRegex(skill[checkpoint:deployment], r"остановись и дождись")

    def test_skill_result_is_exactly_url_login_and_password(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        result = skill.split("## Result contract", 1)[1].strip().splitlines()

        self.assertEqual(result[-3:], [
            "url: <https-url>",
            "login: <generated-login>",
            "password: <generated-password>",
        ])
        self.assertIn("exactly три строки", skill)

    def test_skill_states_resume_idempotence_and_security_invariants(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        for heading in (
            "## Resume invariants",
            "## Idempotence invariants",
            "## Security invariants",
        ):
            self.assertIn(heading, skill)
        for phase in (
            "preflight",
            "awaiting-github-app",
            "github-app-verified",
            "branches-verified",
            "awaiting-ruleset-authority",
            "rulesets-verified",
            "branch-policy-resolved",
            "deployed",
            "verified",
            "reported",
        ):
            self.assertIn(phase, skill)
        self.assertIn("Never call DELETE", skill)
        self.assertIn("никогда не reset/clean local branch", skill)

    def test_skill_supports_private_repositories_without_github_team(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("GitHub Team/Pro не является prerequisite", skill)
        self.assertIn("protected-rulesets", skill)
        self.assertIn("unprotected-degraded", skill)
        self.assertIn("rulesets_feature_unavailable_private_plan", skill)
        self.assertIn("branch-policy-resolved", skill)
        self.assertIn("Installation продолжается", skill)

    def test_skill_renders_the_runtime_only_model_key_config(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        compose = (SKILL / "assets" / "harness-compose.yml").read_text()

        self.assertIn("__VOID_AI_API_KEY_AT_DEPLOY__", skill)
        self.assertIn("replace the marker only in memory", skill)
        self.assertIn("Never store `VOID_AI_API_KEY` as a Service environment variable", skill)
        self.assertIn("content: |\n      __VOID_AI_API_KEY_AT_DEPLOY__", compose)

    def test_skill_assigns_github_operations_to_standard_opencode(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        contract = (SKILL / "references" / "agent-contract.md").read_text()
        combined = skill + "\n" + contract

        self.assertIn("Standard OpenCode", combined)
        self.assertIn("standard OpenCode", combined)
        for action in ("commit", "push", "draft PR", "`gh`"):
            self.assertIn(action, combined)
        for command in ("/merge stage", "/merge stage #<issue>", "/merge prod"):
            self.assertIn(command, combined)
        self.assertNotIn("release agent", combined)

    def test_skill_compose_shares_github_app_context_and_splits_other_secrets(self):
        compose = (SKILL / "assets" / "harness-compose.yml").read_text()
        harness = compose.split("  harness:", 1)[1].split("  opencode-runtime:", 1)[0]
        runtime = compose.split("  opencode-runtime:", 1)[1].split("\nconfigs:", 1)[0]

        for marker in (
            "GITHUB_APP_ID",
            "GITHUB_APP_INSTALLATION_ID",
            "GITHUB_APP_PRIVATE_KEY_PATH",
            "GITHUB_OWNER",
            "GITHUB_REPO",
            "GITHUB_BASE_BRANCH",
        ):
            self.assertIn(marker, harness)
            self.assertIn(marker, runtime)
        self.assertIn("VOID_AI_API_KEY_FILE", runtime)
        self.assertNotIn("VOID_AI_API_KEY", harness)
        self.assertIn("OPENCODE_SERVER_PASSWORD", harness)
        self.assertNotIn("OPENCODE_SERVER_PASSWORD", runtime)
        self.assertNotIn("GITHUB_TOKEN", compose)

    def test_image_publish_workflow_and_release_contract_use_direct_attestation_verification(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-images.yml").read_text()
        release = (SKILL / "references" / "image-release.md").read_text()

        self.assertIn("attestations: write", workflow)
        self.assertIn("actions/attest-build-provenance@", workflow)
        self.assertIn("subject-digest: ${{ steps.build.outputs.digest }}", workflow)
        self.assertIn('if [[ "$GITHUB_REF" != "refs/heads/main" ]]', workflow)
        self.assertIn("gh attestation verify oci://", release)
        self.assertIn("--signer-workflow", release)
        self.assertIn("--source-ref refs/heads/main", release)
        self.assertIn("--deny-self-hosted-runners", release)
        self.assertNotIn("verify_agent.py", release)
        self.assertNotIn("inventory", release.lower())

    def test_image_release_requires_public_canonical_packages(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-images.yml").read_text()
        release = (SKILL / "references" / "image-release.md").read_text()
        skill = (SKILL / "SKILL.md").read_text()

        self.assertNotIn("/visibility", workflow)
        self.assertIn("public GHCR packages", release)
        for image in ("issue-harness", "opencode-web"):
            url = f"https://github.com/orgs/Void0dev/packages/container/{image}/settings"
            self.assertIn(url, release)
            self.assertIn(url, skill)
        self.assertIn("anonymous pull", skill)


if __name__ == "__main__":
    unittest.main()
