import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "skills/deploy-opencode-harness/scripts/github_rulesets.py"


def load_module():
    spec = importlib.util.spec_from_file_location("github_rulesets", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeGitHubApi:
    def __init__(self, rulesets=(), actor_ids=None, failure=None):
        self.rulesets = {item["id"]: dict(item) for item in rulesets}
        self.actor_ids = actor_ids or {}
        self.failure = failure
        self.writes = []
        self.next_id = max(self.rulesets, default=0) + 1

    def resolve_bypass_actor(self, repository, actor_type, actor):
        return self.actor_ids[(actor_type, actor)]

    def list_rulesets(self, repository):
        return [
            {"id": item["id"], "name": item["name"]}
            for item in self.rulesets.values()
        ]

    def get_ruleset(self, repository, ruleset_id):
        if self.failure == "get":
            raise RuntimeError("github_pat_SECRET_MUST_NOT_LEAK")
        return dict(self.rulesets[ruleset_id])

    def create_ruleset(self, repository, payload):
        if self.failure == "create":
            raise RuntimeError("github_pat_SECRET_MUST_NOT_LEAK")
        ruleset_id = self.next_id
        self.next_id += 1
        stored = {"id": ruleset_id, **payload}
        self.rulesets[ruleset_id] = stored
        self.writes.append(("create", ruleset_id, payload))
        return dict(stored)

    def update_ruleset(self, repository, ruleset_id, payload):
        if self.failure == "update":
            raise RuntimeError("github_pat_SECRET_MUST_NOT_LEAK")
        stored = {"id": ruleset_id, **payload}
        self.rulesets[ruleset_id] = stored
        self.writes.append(("update", ruleset_id, payload))
        return dict(stored)


def rule(ruleset, rule_type):
    return next(item for item in ruleset["rules"] if item["type"] == rule_type)


class GitHubRulesetsTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.repository = "acme/widget"
        self.checks = [
            {"context": "ci / test", "integration_id": 91},
            {"context": "security / scan"},
        ]
        self.api = FakeGitHubApi(actor_ids={("Integration", "release-app"): 7001})

    def desired(self, api=None, **overrides):
        return self.module.build_desired_rulesets(
            api or self.api,
            self.repository,
            required_status_checks=overrides.pop("required_status_checks", self.checks),
            release_app="release-app",
            **overrides,
        )

    def test_builds_only_namespaced_active_branch_rulesets_with_exact_checks(self):
        desired = self.desired()

        self.assertEqual(set(desired), {"harness-stage", "harness-production"})
        self.assertEqual(
            desired["harness-stage"]["conditions"]["ref_name"]["include"],
            ["refs/heads/stage"],
        )
        self.assertEqual(
            desired["harness-production"]["conditions"]["ref_name"]["include"],
            ["refs/heads/main"],
        )
        for ruleset in desired.values():
            self.assertEqual(ruleset["target"], "branch")
            self.assertEqual(ruleset["enforcement"], "active")
            self.assertEqual(
                [item["type"] for item in ruleset["rules"]],
                ["deletion", "non_fast_forward", "pull_request", "required_status_checks"],
            )
            self.assertEqual(
                rule(ruleset, "required_status_checks")["parameters"]["required_status_checks"],
                self.checks,
            )
            self.assertEqual(ruleset["bypass_actors"], [{
                "actor_id": 7001,
                "actor_type": "Integration",
                "bypass_mode": "pull_request",
            }])

    def test_empty_proven_checks_do_not_invent_a_required_status_check_rule(self):
        desired = self.desired(required_status_checks=[])

        for ruleset in desired.values():
            self.assertNotIn("required_status_checks", [item["type"] for item in ruleset["rules"]])

    def test_rejects_unrestricted_release_app_bypass_after_resolving_actor_id(self):
        with self.assertRaisesRegex(ValueError, "Release App.*pull_request"):
            self.desired(bypass_actors=[{
                "actor_type": "Integration",
                "actor": "release-app",
                "bypass_mode": "always",
            }])

        with self.assertRaisesRegex(ValueError, "Release App.*pull_request"):
            self.module.build_desired_rulesets(
                self.api,
                self.repository,
                required_status_checks=self.checks,
                release_app={
                    "actor_type": "Integration",
                    "actor": "release-app",
                    "bypass_mode": "always",
                },
            )

    def test_plan_creates_managed_rulesets_and_preserves_unrelated_rulesets(self):
        unrelated = {"id": 44, "name": "security-policy", "target": "branch"}
        api = FakeGitHubApi([unrelated], self.api.actor_ids)

        plan = self.module.plan_rulesets(api, self.repository, self.desired(api))

        self.assertEqual([item["action"] for item in plan], ["create", "create"])
        self.module.apply_ruleset_plan(api, self.repository, plan)
        self.assertEqual(api.rulesets[44], unrelated)
        self.assertEqual([write[0] for write in api.writes], ["create", "create"])

    def test_plan_updates_drift_and_then_second_apply_is_noop(self):
        desired = self.desired()
        existing = []
        for ruleset_id, payload in enumerate(desired.values(), start=10):
            candidate = {"id": ruleset_id, **payload}
            candidate["enforcement"] = "disabled"
            existing.append(candidate)
        api = FakeGitHubApi(existing, self.api.actor_ids)

        first_plan = self.module.plan_rulesets(api, self.repository, desired)
        self.assertEqual([item["action"] for item in first_plan], ["update", "update"])
        self.module.apply_ruleset_plan(api, self.repository, first_plan)
        writes_after_first_apply = list(api.writes)

        second_plan = self.module.plan_rulesets(api, self.repository, desired)
        self.assertEqual([item["action"] for item in second_plan], ["no-op", "no-op"])
        self.module.apply_ruleset_plan(api, self.repository, second_plan)
        self.assertEqual(api.writes, writes_after_first_apply)

    def test_bypass_actor_comparison_uses_resolved_ids_not_input_labels(self):
        desired = self.desired()
        existing = [
            {"id": ruleset_id, **payload}
            for ruleset_id, payload in enumerate(desired.values(), start=20)
        ]
        api = FakeGitHubApi(existing, self.api.actor_ids)

        plan = self.module.plan_rulesets(api, self.repository, desired)

        self.assertEqual([item["action"] for item in plan], ["no-op", "no-op"])

    def test_verify_reads_every_managed_ruleset_with_bootstrap_authority(self):
        desired = self.desired()
        applied_api = FakeGitHubApi(actor_ids=self.api.actor_ids)
        self.module.apply_ruleset_plan(
            applied_api,
            self.repository,
            self.module.plan_rulesets(applied_api, self.repository, desired),
        )
        bootstrap_api = FakeGitHubApi(applied_api.rulesets.values(), self.api.actor_ids)
        workflow_policy = {"production_pull_request_head_ref": "refs/heads/stage"}

        result = self.module.verify_rulesets(
            bootstrap_api,
            self.repository,
            desired,
            workflow_policy=workflow_policy,
            observed_workflow_policy=workflow_policy,
        )

        self.assertEqual(result["verified"], ["harness-stage", "harness-production"])
        self.assertEqual(result["workflow_policy"], workflow_policy)

    def test_verify_rejects_full_readback_or_workflow_policy_mismatch(self):
        desired = self.desired()
        existing = [
            {"id": ruleset_id, **payload}
            for ruleset_id, payload in enumerate(desired.values(), start=30)
        ]
        existing[1]["rules"] = [item for item in existing[1]["rules"] if item["type"] != "deletion"]
        bootstrap_api = FakeGitHubApi(existing, self.api.actor_ids)

        with self.assertRaisesRegex(self.module.VerificationError, "harness-production"):
            self.module.verify_rulesets(bootstrap_api, self.repository, desired)

        clean_api = FakeGitHubApi(
            [{"id": ruleset_id, **payload} for ruleset_id, payload in enumerate(desired.values(), start=40)],
            self.api.actor_ids,
        )
        with self.assertRaisesRegex(self.module.VerificationError, "workflow policy"):
            self.module.verify_rulesets(
                clean_api,
                self.repository,
                desired,
                workflow_policy={"production_pull_request_head_ref": "refs/heads/stage"},
                observed_workflow_policy={"production_pull_request_head_ref": "refs/heads/release"},
            )

        with self.assertRaisesRegex(self.module.VerificationError, "workflow policy"):
            self.module.verify_rulesets(clean_api, self.repository, desired)

    def test_api_errors_never_echo_tokens(self):
        desired = self.desired()
        api = FakeGitHubApi(actor_ids=self.api.actor_ids, failure="create")
        plan = self.module.plan_rulesets(api, self.repository, desired)

        with self.assertRaises(self.module.RulesetApiError) as raised:
            self.module.apply_ruleset_plan(api, self.repository, plan)

        self.assertNotIn("github_pat_SECRET_MUST_NOT_LEAK", str(raised.exception))
        self.assertNotIn("SECRET", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
