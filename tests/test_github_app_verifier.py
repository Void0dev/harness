import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    ROOT
    / "skills"
    / "deploy-opencode-harness"
    / "scripts"
    / "github_app_verifier.py"
)

def load_verifier():
    spec = importlib.util.spec_from_file_location("github_app_verifier", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ScriptedTransport:
    def __init__(self, module, responses):
        self.module = module
        self.responses = list(responses)
        self.requests = []

    def request(self, method, url, headers, body=None):
        self.requests.append((method, url, dict(headers), body))
        expected_method, expected_path, status, payload = self.responses.pop(0)
        self.assert_request(method, url, expected_method, expected_path)
        return self.module.HttpResponse(
            status=status,
            headers={"content-type": "application/json"},
            body=json.dumps(payload).encode("utf-8"),
        )

    def assert_request(self, method, url, expected_method, expected_path):
        if method != expected_method:
            raise AssertionError(f"expected {expected_method}, got {method}")
        parsed = urlsplit(url)
        actual_path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        if actual_path != expected_path:
            raise AssertionError(f"expected {expected_path}, got {actual_path}")


class GitHubAppVerifierTests(unittest.TestCase):
    def setUp(self):
        self.verifier = load_verifier()
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.private_key_path = Path(self.tempdir.name) / "release-app.pem"
        self.private_key_path.write_text("synthetic test key")

    def transport(self, *, installations=None, repositories=None, permissions=None):
        installations = installations or [
            {"id": 88, "account": {"login": "acme"}}
        ]
        repositories = repositories or [{"full_name": "acme/widget"}]
        permissions = permissions or {
            "metadata": "read",
            "contents": "write",
            "issues": "write",
            "pull_requests": "write",
            "checks": "read",
        }
        return ScriptedTransport(
            self.verifier,
            [
                ("GET", "/app", 200, {"id": 12345, "slug": "acme-release"}),
                ("GET", "/app/installations?per_page=100&page=1", 200, installations),
                (
                    "POST",
                    "/app/installations/88/access_tokens",
                    201,
                    {
                        "token": "ghs_installation_secret",
                        "expires_at": "2030-01-01T00:00:00Z",
                        "permissions": permissions,
                        "repository_selection": "selected",
                    },
                ),
                (
                    "GET",
                    "/installation/repositories?per_page=100&page=1",
                    200,
                    {"total_count": len(repositories), "repositories": repositories},
                ),
            ],
        )

    def verify(self, transport):
        with (
            mock.patch.object(self.verifier, "_read_private_key", return_value=b"synthetic"),
            mock.patch.object(self.verifier, "_create_app_jwt", return_value="redacted.app.jwt"),
        ):
            return self.verifier.verify_github_release_app(
                app_id="12345",
                private_key_path=self.private_key_path,
                expected_repository="acme/widget",
                transport=transport,
                now=lambda: 1_800_000_000,
            )

    def assert_error_code(self, expected_code, callback):
        with self.assertRaises(self.verifier.VerificationError) as raised:
            callback()
        self.assertEqual(raised.exception.code, expected_code)
        return raised.exception

    def test_rejects_invalid_pem_without_contacting_github(self):
        self.private_key_path.write_text("definitely not a private key")
        transport = ScriptedTransport(self.verifier, [])

        error = self.assert_error_code(
            "invalid_private_key",
            lambda: self.verifier.verify_github_release_app(
                app_id="12345",
                private_key_path=self.private_key_path,
                expected_repository="acme/widget",
                transport=transport,
                now=lambda: 1_800_000_000,
            ),
        )

        self.assertEqual(transport.requests, [])
        self.assertNotIn(str(self.private_key_path), str(error))
        self.assertNotIn("definitely not a private key", str(error))

    def test_reports_wrong_app_id_as_redacted_auth_failure(self):
        transport = ScriptedTransport(
            self.verifier,
            [("GET", "/app", 401, {"message": "Bad credentials for 12345"})],
        )

        error = self.assert_error_code("github_app_auth_failed", lambda: self.verify(transport))

        self.assertNotIn("12345", str(error))
        self.assertNotIn("Bad credentials", str(error))
        self.assertNotIn("synthetic test key", str(error))

    def test_rejects_zero_matching_installations(self):
        transport = ScriptedTransport(
            self.verifier,
            [
                ("GET", "/app", 200, {"id": 12345}),
                ("GET", "/app/installations?per_page=100&page=1", 200, []),
            ],
        )

        self.assert_error_code("installation_not_found", lambda: self.verify(transport))

    def test_rejects_multiple_matching_installations(self):
        transport = ScriptedTransport(
            self.verifier,
            [
                ("GET", "/app", 200, {"id": 12345}),
                (
                    "GET",
                    "/app/installations?per_page=100&page=1",
                    200,
                    [
                        {"id": 88, "account": {"login": "acme"}},
                        {"id": 99, "account": {"login": "ACME"}},
                    ],
                ),
            ],
        )

        self.assert_error_code("installation_ambiguous", lambda: self.verify(transport))

    def test_rejects_repository_scope_that_is_not_exact(self):
        transport = self.transport(
            repositories=[
                {"full_name": "acme/widget"},
                {"full_name": "acme/other"},
            ]
        )

        self.assert_error_code("repository_scope_mismatch", lambda: self.verify(transport))

    def test_rejects_missing_or_weaker_required_permission(self):
        transport = self.transport(
            permissions={
                "metadata": "read",
                "contents": "read",
                "issues": "write",
                "pull_requests": "write",
            }
        )

        error = self.assert_error_code("permission_mismatch", lambda: self.verify(transport))

        self.assertEqual(error.details, {"permission": "contents", "required": "write"})

    def test_rejects_missing_checks_read_permission(self):
        transport = self.transport(
            permissions={
                "metadata": "read",
                "contents": "write",
                "issues": "write",
                "pull_requests": "write",
            }
        )

        error = self.assert_error_code("permission_mismatch", lambda: self.verify(transport))

        self.assertEqual(error.details, {"permission": "checks", "required": "read"})

    def test_rejects_administration_permission(self):
        transport = self.transport(
            permissions={
                "metadata": "read",
                "contents": "write",
                "issues": "write",
                "pull_requests": "write",
                "checks": "read",
                "administration": "write",
            }
        )

        self.assert_error_code("excessive_permission", lambda: self.verify(transport))

    def test_emits_successful_redacted_structured_json(self):
        transport = self.transport()

        report = self.verify(transport)
        output = io.StringIO()
        self.verifier.emit_json(report, output)
        rendered = output.getvalue()
        decoded = json.loads(rendered)

        self.assertEqual(
            decoded,
            {
                "github_app": {
                    "authenticated": True,
                    "installation": {"account": "acme", "id": 88, "resolved": True},
                    "permissions": {
                        "administration": "none",
                        "checks": "read",
                        "contents": "write",
                        "issues": "write",
                        "metadata": "read",
                        "pull_requests": "write",
                    },
                    "repository_scope": {
                        "repositories": ["acme/widget"],
                        "selection": "selected",
                    },
                },
                "ok": True,
                "redacted": [
                    "app_id",
                    "private_key",
                    "app_jwt",
                    "installation_token",
                ],
            },
        )
        self.assertNotIn("12345", rendered)
        self.assertNotIn(str(self.private_key_path), rendered)
        self.assertNotIn("ghs_installation_secret", rendered)
        self.assertNotIn("synthetic test key", rendered)
        self.assertTrue(rendered.endswith("\n"))
        self.assertEqual(transport.responses, [])


if __name__ == "__main__":
    unittest.main()
