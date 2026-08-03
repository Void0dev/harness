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
    def test_production_compose_exposes_only_public_harness_and_private_runtime(self):
        compose = (ROOT / "coolify" / "harness.production.compose.yml").read_text()

        harness = service_block(compose, "harness")
        runtime = service_block(compose, "opencode-runtime")
        self.assertNotRegex(compose, r"(?m)^  opencode-web:$")
        self.assertEqual(compose.count("SERVICE_FQDN_"), 1)
        self.assertIn("SERVICE_FQDN_HARNESS_4096: /", harness)
        self.assertNotIn("SERVICE_FQDN_", runtime)

    def test_github_app_context_is_available_to_both_services_but_web_and_model_secrets_stay_split(self):
        compose = (
            ROOT / "skills/deploy-opencode-harness/assets/harness-compose.yml"
        ).read_text()
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

        for marker in (
            "OPENCODE_SERVER_USERNAME",
            "OPENCODE_SERVER_PASSWORD",
            "OPENCODE_SESSION_SECRET",
        ):
            self.assertIn(marker, harness)
            self.assertNotIn(marker, runtime)

        self.assertNotIn("VOID_AI_API_KEY", harness)
        self.assertIn("VOID_AI_API_KEY_FILE", runtime)
        self.assertIn("OPENCODE_SERVER_URL: http://opencode-runtime:4096", harness)
        self.assertIn('user: "10001:20001"', harness)
        self.assertIn('user: "10002:20001"', runtime)

    def test_every_compose_variant_passes_release_app_credentials_to_runtime(self):
        variants = (
            ("docker-compose.local.yml", "GITHUB_APP_PRIVATE_KEY_PATH", "/run/secrets/github-app.pem:ro"),
            ("coolify/docker-compose.yml", "GITHUB_APP_PRIVATE_KEY_PATH", "/run/secrets/github-app.pem:ro"),
            ("skills/deploy-opencode-harness/assets/harness-compose.yml", "GITHUB_APP_PRIVATE_KEY_PATH", "/run/secrets/github-app.pem:ro"),
            ("coolify/harness.production.compose.yml", "GITHUB_APP_PRIVATE_KEY_BASE64_PATH", "source: github-app-pem"),
        )
        for relative, key_marker, mount_marker in variants:
            compose = (ROOT / relative).read_text()
            harness = service_block(compose, "harness")
            runtime = service_block(compose, "opencode-runtime")
            with self.subTest(compose=relative):
                for marker in (
                    "GITHUB_APP_ID",
                    "GITHUB_APP_INSTALLATION_ID",
                    "GITHUB_OWNER",
                    "GITHUB_REPO",
                    "GITHUB_BASE_BRANCH",
                    key_marker,
                ):
                    self.assertIn(marker, harness)
                    self.assertIn(marker, runtime)
                self.assertIn(mount_marker, harness)
                self.assertIn(mount_marker, runtime)
                self.assertNotIn("GITHUB_TOKEN", compose)

    def test_local_and_production_compose_use_the_same_two_service_names(self):
        for relative in (
            "docker-compose.local.yml",
            "coolify/docker-compose.yml",
            "skills/deploy-opencode-harness/assets/harness-compose.yml",
        ):
            compose = (ROOT / relative).read_text()
            with self.subTest(compose=relative):
                harness = service_block(compose, "harness")
                runtime = service_block(compose, "opencode-runtime")
                self.assertNotRegex(compose, r"(?m)^  opencode-web:$")
                self.assertIn('user: "10001:20001"', harness)
                self.assertIn('user: "10002:20001"', runtime)
                self.assertIn("cap_drop:\n      - ALL", harness)
                self.assertIn("cap_drop:\n      - ALL", runtime)

    def test_public_port_is_explicit_in_the_example_environment(self):
        environment = (ROOT / ".env.example").read_text()
        self.assertIn("OPENCODE_PUBLIC_PORT=4096", environment)


if __name__ == "__main__":
    unittest.main()
