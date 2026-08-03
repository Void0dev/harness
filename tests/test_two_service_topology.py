import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def service_block(compose: str, name: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [a-z0-9][a-z0-9-]*:\n|^(?:volumes|secrets|configs):|\Z)",
        compose,
    )
    if not match:
        raise AssertionError(f"missing service {name}")
    return match.group("body")


class TwoServiceTopologyTest(unittest.TestCase):
    def test_canonical_compose_exposes_only_public_harness_and_private_runtime(self):
        compose = (ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml").read_text()
        harness = service_block(compose, "harness")
        runtime = service_block(compose, "opencode-runtime")

        self.assertNotIn("SERVICE_FQDN_", compose)
        self.assertIn("image: ${HARNESS_IMAGE:?set an immutable harness image digest}", harness)
        self.assertIn("image: ${OPENCODE_WEB_IMAGE:?set an immutable OpenCode Web image digest}", runtime)
        self.assertNotIn("build:", compose)

    def test_github_app_context_is_shared_but_web_and_model_secrets_stay_split(self):
        compose = (ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml").read_text()
        harness = service_block(compose, "harness")
        runtime = service_block(compose, "opencode-runtime")

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
        self.assertIn("OPENCODE_SERVER_PASSWORD", harness)
        self.assertNotIn("OPENCODE_SERVER_PASSWORD", runtime)
        self.assertNotIn("VOID_AI_API_KEY", harness)
        self.assertIn("VOID_AI_API_KEY_FILE", runtime)
        self.assertNotIn("GITHUB_TOKEN", compose)

    def test_local_and_canonical_compose_keep_the_same_two_service_names(self):
        for relative in (
            "docker-compose.local.yml",
            "skills/deploy-opencode-harness/assets/harness-compose.yml",
        ):
            compose = (ROOT / relative).read_text()
            with self.subTest(compose=relative):
                harness = service_block(compose, "harness")
                runtime = service_block(compose, "opencode-runtime")
                self.assertIn('user: "10001:20001"', harness)
                self.assertIn('user: "10002:20001"', runtime)
                self.assertIn("cap_drop:\n      - ALL", harness)
                self.assertIn("cap_drop:\n      - ALL", runtime)

    def test_provider_specific_coolify_manifests_are_removed(self):
        self.assertFalse((ROOT / "coolify/docker-compose.yml").exists())
        self.assertFalse((ROOT / "coolify/harness.production.compose.yml").exists())

    def test_public_port_is_explicit_in_the_example_environment(self):
        environment = (ROOT / ".env.example").read_text()
        self.assertIn("OPENCODE_PUBLIC_PORT=4096", environment)


if __name__ == "__main__":
    unittest.main()
