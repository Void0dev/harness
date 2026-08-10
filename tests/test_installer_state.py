import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = (
    ROOT
    / "skills"
    / "deploy-opencode-harness"
    / "scripts"
    / "installer_state.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location("installer_state", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InstallerCapabilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.installer = load_module()

    def capabilities(self):
        return [
            {"outcome": outcome.replace("-", "_"), "handle": f"provider:{index}"}
            for index, outcome in enumerate(
                self.installer.REQUIRED_CAPABILITY_OUTCOMES,
                start=1,
            )
        ]

    def test_normalizes_provider_capabilities_by_required_outcome(self):
        normalized = self.installer.normalize_capabilities(self.capabilities())

        self.assertEqual(
            tuple(normalized),
            self.installer.REQUIRED_CAPABILITY_OUTCOMES,
        )
        self.assertEqual(normalized["https-route"], "provider:6")
        self.assertIn("deployment-definition", normalized)
        self.assertNotIn("artifact-materialization", normalized)

    def test_reports_all_missing_capability_outcomes_without_provider_assumptions(self):
        observed = self.capabilities()
        observed = [
            item
            for item in observed
            if item["outcome"] not in {"secret_storage", "private_harness_probe"}
        ]

        with self.assertRaises(self.installer.MissingCapabilitiesError) as caught:
            self.installer.normalize_capabilities(observed)

        self.assertEqual(
            caught.exception.missing,
            ("secret-storage", "private-harness-probe"),
        )
        self.assertNotIn("coolify", str(caught.exception).lower())
        self.assertNotIn("ssh", str(caught.exception).lower())


class InstallerIdentityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.installer = load_module()

    def test_identity_is_deterministic_and_repository_scoped(self):
        expected_hash = hashlib.sha256(b"acme/payments_api").hexdigest()

        first = self.installer.harness_identity("Acme/Payments_API")
        second = self.installer.harness_identity("acme/payments_api")

        self.assertEqual(first, second)
        self.assertEqual(first, f"harness-acme-payments-api-{expected_hash[:8]}")
        self.assertEqual(
            self.installer.repository_hash("Acme/Payments_API"),
            expected_hash,
        )

    def test_classifies_absent_compatible_and_conflicting_resources(self):
        repository = "acme/payments"
        environment = "environment-42"
        identity = self.installer.harness_identity(repository)

        self.assertEqual(
            self.installer.classify_resource_action(
                repository, environment, []
            ),
            "create",
        )
        self.assertEqual(
            self.installer.classify_resource_action(
                repository,
                environment,
                [{
                    "identity": identity,
                    "repository": "ACME/PAYMENTS",
                    "environment": environment,
                }],
            ),
            "reconcile",
        )
        self.assertEqual(
            self.installer.classify_resource_action(
                repository,
                environment,
                [{
                    "identity": identity,
                    "repository": "acme/other",
                    "environment": environment,
                }],
            ),
            "collision",
        )

    def test_duplicate_matching_resources_are_a_collision(self):
        repository = "acme/payments"
        environment = "environment-42"
        resource = {
            "identity": self.installer.harness_identity(repository),
            "repository": repository,
            "environment": environment,
        }

        self.assertEqual(
            self.installer.classify_resource_action(
                repository, environment, [resource, dict(resource)]
            ),
            "collision",
        )


class InstallerStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.installer = load_module()

    def state(self):
        return self.installer.new_state(
            "acme/payments",
            "environment-42",
            secret_refs={
                "deployment_token": "secret://deployment/token-ref",
                "github_app_pem": "secret://github/release-app-key-ref",
            },
            metadata={
                "github_app_id": "12345",
                "desired_state_digest": "sha256:" + "a" * 64,
            },
        )

    def test_phase_progression_is_monotonic_and_same_phase_is_a_noop(self):
        state = self.state()
        advanced = self.installer.advance_phase(state, "awaiting-github-app")

        self.assertEqual(state["phase"], "preflight")
        self.assertEqual(advanced["phase"], "awaiting-github-app")
        self.assertIs(
            self.installer.advance_phase(advanced, "awaiting-github-app"),
            advanced,
        )
        with self.assertRaisesRegex(ValueError, "phase regression"):
            self.installer.advance_phase(advanced, "preflight")

    def test_resolves_verified_rulesets_as_protected_branch_policy(self):
        state = self.installer.advance_phase(self.state(), "rulesets-verified")

        resolved = self.installer.resolve_branch_policy(
            state,
            "protected-rulesets",
        )

        self.assertEqual(resolved["phase"], "branch-policy-resolved")
        self.assertEqual(
            resolved["metadata"]["branch_policy_mode"],
            "protected-rulesets",
        )

    def test_allows_private_plan_fallback_without_github_team(self):
        state = self.installer.advance_phase(
            self.state(),
            "awaiting-ruleset-authority",
        )
        state["metadata"]["last_error_code"] = (
            "rulesets_feature_unavailable_private_plan"
        )

        resolved = self.installer.resolve_branch_policy(
            state,
            "unprotected-degraded",
        )

        self.assertEqual(resolved["phase"], "branch-policy-resolved")
        self.assertEqual(
            resolved["metadata"]["branch_policy_mode"],
            "unprotected-degraded",
        )
        self.assertEqual(
            resolved["metadata"]["last_error_code"],
            "rulesets_feature_unavailable_private_plan",
        )

    def test_rejects_degraded_policy_for_an_ambiguous_ruleset_failure(self):
        state = self.installer.advance_phase(
            self.state(),
            "awaiting-ruleset-authority",
        )
        state["metadata"]["last_error_code"] = "rulesets_api_forbidden"

        with self.assertRaisesRegex(ValueError, "private-plan limitation"):
            self.installer.resolve_branch_policy(
                state,
                "unprotected-degraded",
            )

    def test_cannot_deploy_without_a_resolved_branch_policy(self):
        state = self.installer.advance_phase(self.state(), "rulesets-verified")

        with self.assertRaisesRegex(ValueError, "branch policy must be resolved"):
            self.installer.advance_phase(state, "deployed")

    def test_state_path_is_keyed_by_full_repository_hash(self):
        root = pathlib.Path("/tmp/installer-state")
        expected = self.installer.repository_hash("acme/payments") + ".json"

        self.assertEqual(
            self.installer.state_path(root, "ACME/PAYMENTS"),
            root / expected,
        )

    def test_save_is_atomic_private_and_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "state"
            state = self.state()

            path = self.installer.save_state(root, state)
            first_stat = path.stat()
            first_bytes = path.read_bytes()
            saved_again = self.installer.save_state(root, state)

            self.assertEqual(saved_again, path)
            self.assertEqual(path.read_bytes(), first_bytes)
            self.assertEqual(path.stat().st_ino, first_stat.st_ino)
            self.assertEqual(os.stat(root).st_mode & 0o777, 0o700)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(list(root.glob("*.tmp")))

    def test_reload_is_idempotent_and_returns_independent_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "state"
            expected = self.state()
            self.installer.save_state(root, expected)

            first = self.installer.load_state(root, "acme/payments")
            second = self.installer.load_state(root, "ACME/PAYMENTS")
            first["metadata"]["github_app_id"] = "changed-in-memory"

            self.assertEqual(second, expected)
            self.assertEqual(
                self.installer.load_state(root, "acme/payments"), expected
            )

    def test_rejects_secret_fields_and_redacts_values_from_errors(self):
        state = self.state()
        leaked = "super-secret-password-value"
        state["chat_password"] = leaked

        with self.assertRaises(self.installer.SecretStateError) as caught:
            self.installer.validate_state(state)

        self.assertIn("chat_password", str(caught.exception))
        self.assertNotIn(leaked, str(caught.exception))

    def test_rejects_non_opaque_values_inside_secret_refs(self):
        state = self.state()
        state["secret_refs"]["github_app_pem"] = "literal credential material"

        with self.assertRaisesRegex(
            self.installer.SecretStateError, "opaque secret reference"
        ):
            self.installer.validate_state(state)

    def test_rejects_nested_secret_fields_without_leaking_the_value(self):
        state = self.state()
        leaked = "nested-token-value"
        state["metadata"]["completed_operations"] = [
            {"operation": "configure", "token": leaked}
        ]

        with self.assertRaises(self.installer.SecretStateError) as caught:
            self.installer.validate_state(state)

        self.assertIn("token", str(caught.exception))
        self.assertNotIn(leaked, str(caught.exception))

    def test_persisted_json_contains_refs_but_no_secret_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "state"
            state = self.state()
            path = self.installer.save_state(root, state)
            payload = json.loads(path.read_text())

            self.assertEqual(
                payload["secret_refs"]["deployment_token"],
                "secret://deployment/token-ref",
            )
            self.assertNotIn("chat_password", payload)
            self.assertNotIn("pem", json.dumps(payload).lower().replace("github_app_pem", ""))

    def test_rejects_removed_metadata_fields(self):
        for field in ("artifact_digest", "diagnostics_ref", "release_status"):
            with self.subTest(field=field):
                state = self.state()
                state["metadata"][field] = "obsolete"
                with self.assertRaisesRegex(ValueError, "unexpected metadata fields"):
                    self.installer.validate_state(state)


if __name__ == "__main__":
    unittest.main()
