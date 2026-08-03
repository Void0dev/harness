import importlib.util
import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/deploy-opencode-harness/scripts/github_branches.py"


def load_module():
    spec = importlib.util.spec_from_file_location("github_branches", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, method, url, headers, body):
        self.requests.append({
            "method": method,
            "url": url,
            "headers": dict(headers),
            "body": body,
        })
        if not self.responses:
            raise AssertionError("unexpected GitHub API request")
        response = self.responses.pop(0)
        if callable(response):
            return response(method, url, headers, body)
        return response


class GitHubBranchBootstrapTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.token = "github_pat_secret-never-print"
        self.main_sha = "a" * 40
        self.stage_sha = "b" * 40

    def response(self, status, payload=None):
        return self.module.ApiResponse(status=status, payload=payload)

    def ref(self, name, sha):
        return {
            "ref": f"refs/heads/{name}",
            "object": {"type": "commit", "sha": sha},
        }

    def bootstrap(self, responses, mode="apply"):
        transport = FakeTransport(responses)
        result = self.module.bootstrap_repository_branches(
            repository="acme/service",
            token=self.token,
            mode=mode,
            transport=transport,
            api_url="https://api.github.test",
        )
        return result, transport

    def test_missing_main_is_a_hard_block_without_mutation(self):
        result, transport = self.bootstrap([
            self.response(404, {"message": "Not Found"}),
        ])

        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["error"]["code"], "main_missing")
        self.assertEqual([request["method"] for request in transport.requests], ["GET"])
        self.assertEqual(result["main"], {"ref": "refs/heads/main", "exists": False})

    def test_existing_stage_is_recorded_and_left_unchanged(self):
        result, transport = self.bootstrap([
            self.response(200, self.ref("main", self.main_sha)),
            self.response(200, self.ref("stage", self.stage_sha)),
        ])

        self.assertEqual(result["status"], "noop")
        self.assertEqual(result["stage"]["sha"], self.stage_sha)
        self.assertEqual(result["actions"], [])
        self.assertEqual([request["method"] for request in transport.requests], ["GET", "GET"])

    def test_missing_stage_is_created_at_the_exact_current_main_sha(self):
        result, transport = self.bootstrap([
            self.response(200, self.ref("main", self.main_sha)),
            self.response(404, {"message": "Not Found"}),
            self.response(201, self.ref("stage", self.main_sha)),
        ])

        self.assertEqual(result["status"], "created")
        self.assertEqual(result["stage"]["sha"], self.main_sha)
        create = transport.requests[2]
        self.assertEqual(create["method"], "POST")
        self.assertEqual(create["url"], "https://api.github.test/repos/acme/service/git/refs")
        self.assertEqual(
            json.loads(create["body"].decode("utf-8")),
            {"ref": "refs/heads/stage", "sha": self.main_sha},
        )
        self.assertEqual(create["headers"]["Authorization"], f"Bearer {self.token}")

    def test_plan_reports_exact_create_without_mutating(self):
        result, transport = self.bootstrap([
            self.response(200, self.ref("main", self.main_sha)),
            self.response(404, {"message": "Not Found"}),
        ], mode="plan")

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["actions"], [{
            "operation": "create",
            "ref": "refs/heads/stage",
            "sha": self.main_sha,
        }])
        self.assertEqual([request["method"] for request in transport.requests], ["GET", "GET"])

    def test_policy_blocked_creation_returns_a_structured_block(self):
        result, transport = self.bootstrap([
            self.response(200, self.ref("main", self.main_sha)),
            self.response(404, {"message": "Not Found"}),
            self.response(403, {"message": "Repository policy denied ref creation"}),
        ])

        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["error"], {
            "code": "stage_creation_blocked",
            "message": "Repository policy denied ref creation",
            "httpStatus": 403,
        })
        self.assertEqual(len([request for request in transport.requests if request["method"] == "POST"]), 1)

    def test_rerun_after_creation_is_a_noop(self):
        state = {"stage": None}

        def respond(method, url, headers, body):
            if url.endswith("/git/ref/heads/main"):
                return self.response(200, self.ref("main", self.main_sha))
            if url.endswith("/git/ref/heads/stage"):
                if state["stage"] is None:
                    return self.response(404, {"message": "Not Found"})
                return self.response(200, self.ref("stage", state["stage"]))
            payload = json.loads(body.decode("utf-8"))
            state["stage"] = payload["sha"]
            return self.response(201, self.ref("stage", state["stage"]))

        transport = FakeTransport([respond, respond, respond, respond, respond])
        first = self.module.bootstrap_repository_branches(
            "acme/service", self.token, "apply", transport,
            api_url="https://api.github.test",
        )
        second = self.module.bootstrap_repository_branches(
            "acme/service", self.token, "apply", transport,
            api_url="https://api.github.test",
        )

        self.assertEqual(first["status"], "created")
        self.assertEqual(second["status"], "noop")
        self.assertEqual(len([request for request in transport.requests if request["method"] == "POST"]), 1)

    def test_malformed_refs_and_shas_are_hard_blocks(self):
        cases = (
            (self.ref("other", self.main_sha), None, "malformed_main_ref"),
            (self.ref("main", "not-a-sha"), None, "malformed_main_ref"),
            (self.ref("main", self.main_sha), self.ref("other", self.stage_sha), "malformed_stage_ref"),
            (self.ref("main", self.main_sha), self.ref("stage", "xyz"), "malformed_stage_ref"),
        )
        for main, stage, code in cases:
            with self.subTest(code=code, main=main, stage=stage):
                responses = [self.response(200, main)]
                if stage is not None:
                    responses.append(self.response(200, stage))
                result, transport = self.bootstrap(responses)
                self.assertEqual(result["status"], "blocked")
                self.assertEqual(result["error"]["code"], code)
                self.assertNotIn("POST", [request["method"] for request in transport.requests])

    def test_token_is_redacted_from_all_structured_output(self):
        result, transport = self.bootstrap([
            self.response(200, self.ref("main", self.main_sha)),
            self.response(404, {"message": "Not Found"}),
            self.response(422, {
                "message": f"policy rejected Authorization: Bearer {self.token}",
                "errors": [{"message": self.token}],
            }),
        ])

        rendered = json.dumps(result, sort_keys=True)
        self.assertNotIn(self.token, rendered)
        self.assertIn("[REDACTED]", rendered)
        self.assertNotIn(self.token, json.dumps([
            {key: value for key, value in request.items() if key != "headers"}
            for request in transport.requests
        ], default=str))


if __name__ == "__main__":
    unittest.main()
