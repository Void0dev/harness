import base64
import pathlib
import re
import stat
import subprocess
import tempfile
import unittest
import os


ROOT = pathlib.Path(__file__).resolve().parents[1]

SECRET_PATTERNS = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "GitHub fine-grained PAT": re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{82}\b"),
    "OpenAI API key": re.compile(
        rb"\bsk-(?:[A-Za-z0-9]{48}|(?:proj|svcacct)-[A-Za-z0-9_-]{64,})\b"
    ),
    "AWS access key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "Slack token": re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
}


def git(*args):
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class RepositoryHygieneTest(unittest.TestCase):
    def test_removed_skill_name_is_absent_from_discoverable_metadata_and_docs(self):
        listed = git("ls-files", "--cached", "--others", "--exclude-standard")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        allowed = {
            pathlib.Path("tests/test_repository_hygiene.py"),
            pathlib.Path("tests/test_skills.py"),
        }
        stale = []
        for relative in map(pathlib.Path, listed.stdout.splitlines()):
            path = ROOT / relative
            if relative in allowed or not path.is_file() or "__pycache__" in path.parts:
                continue
            content = path.read_bytes()
            if b"\0" in content:
                continue
            if b"deploy-issue-harness-agent" in content:
                stale.append(str(relative))

        self.assertEqual(stale, [])

    def test_docker_build_context_excludes_runtime_and_credential_material(self):
        patterns = {
            line.strip()
            for line in (ROOT / ".dockerignore").read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        required = {
            ".omx",
            ".harness",
            ".sandcastle",
            ".env.*",
            "**/.env",
            "**/.env.*",
            "!.env.example",
            "!**/.env.example",
            "*.log",
            "**/*.log",
            "**/*.key",
            "**/*.pem",
            "**/*.p12",
            "**/*.pfx",
            "*.key",
            "*.pem",
            "*.p12",
            "*.pfx",
            ".npmrc",
            ".netrc",
            ".docker/config.json",
            "id_rsa",
            "id_ed25519",
            "**/.npmrc",
            "**/.netrc",
            "**/.docker/config.json",
            "**/id_rsa",
            "**/id_ed25519",
        }

        self.assertEqual(required - patterns, set())

    def test_runtime_and_environment_secret_paths_are_ignored(self):
        runtime_paths = [
            ".harness/auth/github-token",
            ".harness/logs/issue-1.log",
            ".harness/state/issues.json",
            ".harness/sandboxes/issue-1/container.json",
            ".harness/workspaces/issue-1/.git",
            ".harness/runs/issue-1.json",
            ".harness/artifacts/issue-1.bundle",
            ".harness/publishers/issue-1/lease.json",
            ".harness/docker-certs/key.pem",
            ".harness/locks/deploy.lock",
            ".omx/state/ultragoal.json",
            ".sandcastle/legacy.log",
            "credentials/client.key",
            "credentials/client.pem",
            "credentials/client.p12",
            "credentials/client.pfx",
            ".npmrc",
            "services/example/.netrc",
            ".docker/config.json",
            "secrets/id_rsa",
            "secrets/id_ed25519",
            ".env.production",
            "services/example/.env.local",
        ]

        for candidate in runtime_paths:
            with self.subTest(candidate=candidate):
                result = git("check-ignore", "--no-index", "-q", candidate)
                self.assertEqual(result.returncode, 0, candidate)

    def test_declarative_contract_remains_trackable(self):
        trackable_paths = [
            ".harness/config.json",
            ".env.example",
            "services/example/.env.example",
        ]

        for candidate in trackable_paths:
            with self.subTest(candidate=candidate):
                result = git("check-ignore", "--no-index", "-q", candidate)
                self.assertNotEqual(result.returncode, 0, candidate)

    def test_no_tracked_file_lives_in_a_runtime_or_secret_path(self):
        result = git("ls-files", "-z")
        self.assertEqual(result.returncode, 0, result.stderr)
        tracked = [path for path in result.stdout.split("\0") if path]
        allowed_harness = {
            ".harness/config.json",
        }
        forbidden = []
        for filename in tracked:
            path = pathlib.PurePosixPath(filename)
            if filename.startswith(".harness/") and filename not in allowed_harness:
                forbidden.append(filename)
            if path.name == ".env" or (path.name.startswith(".env.") and path.name != ".env.example"):
                forbidden.append(filename)
            if path.suffix.lower() in {".key", ".pem", ".p12", ".pfx"}:
                forbidden.append(filename)
            if path.name in {".npmrc", ".netrc", "id_rsa", "id_ed25519"}:
                forbidden.append(filename)
            if len(path.parts) >= 2 and path.parts[-2:] == (".docker", "config.json"):
                forbidden.append(filename)

        self.assertEqual(forbidden, [])

    def test_commit_candidate_text_has_no_high_confidence_secret_material(self):
        result = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
        self.assertEqual(result.returncode, 0, result.stderr)
        findings = []
        for filename in (path for path in result.stdout.split("\0") if path):
            candidate = ROOT / filename
            if not candidate.is_file():
                continue
            content = candidate.read_bytes()
            if b"\0" in content:
                continue
            for label, pattern in SECRET_PATTERNS.items():
                if pattern.search(content):
                    findings.append(f"{filename}: {label}")

        self.assertEqual(findings, [])

    @unittest.skipIf(os.name == "nt", "Unix permission semantics are verified on Linux")
    def test_runtime_permissions_are_private(self):
        private_directories = [
            "logs",
            "state",
            "artifacts",
            "publishers",
        ]
        shared_directories = [
            "runs",
            "context",
        ]
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = pathlib.Path(temporary) / "repository"
            for relative in private_directories + shared_directories:
                directory = data_dir / relative
                directory.mkdir(parents=True, mode=0o755)
                directory.chmod(0o755)
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    (
                        "source services/issue-harness/runtime_permissions.sh; "
                        'harden_harness_runtime "$1"'
                    ),
                    "runtime-permissions-test",
                    str(data_dir),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            self.assertEqual(stat.S_IMODE(data_dir.stat().st_mode), 0o700)

            for relative in private_directories:
                with self.subTest(directory=relative):
                    mode = stat.S_IMODE((data_dir / relative).stat().st_mode)
                    self.assertEqual(mode, 0o700)

            for relative in shared_directories:
                with self.subTest(shared_directory=relative):
                    mode = stat.S_IMODE((data_dir / relative).stat().st_mode)
                    self.assertEqual(mode, 0o2770)

    @unittest.skipIf(os.name == "nt", "Unix permission semantics are verified on Linux")
    def test_base64_github_app_secret_becomes_private_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            secret_file = pathlib.Path(temporary) / "github-app.pem.b64"
            secret_file.write_text(base64.b64encode(b"test-github-app-key\n").decode())
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    (
                        "source services/issue-harness/github_app_secret.sh; "
                        "GITHUB_APP_PRIVATE_KEY_BASE64_PATH=\"$1\"; "
                        "prepare_github_app_private_key; "
                        "key_path=\"$GITHUB_APP_PRIVATE_KEY_PATH\"; "
                        "test \"$(cat \"$key_path\")\" = test-github-app-key; "
                        "test \"$(stat -c %a \"$key_path\")\" = 600; "
                        "cleanup_github_app_private_key; "
                        "test ! -e \"$key_path\""
                    ),
                    "github-app-secret-test",
                    str(secret_file),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
    @unittest.skipIf(os.name == "nt", "Creating symlinks requires extra Windows privileges")
    def test_runtime_hardening_rejects_symlinked_runtime_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = pathlib.Path(temporary) / "repository"
            data_dir.mkdir(parents=True)
            target = pathlib.Path(temporary) / "outside-context"
            target.mkdir()
            (data_dir / "context").symlink_to(target, target_is_directory=True)

            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    (
                        "source services/issue-harness/runtime_permissions.sh; "
                        'harden_harness_runtime "$1"'
                    ),
                    "runtime-permissions-test",
                    str(data_dir),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symbolic-link", result.stderr)
            self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
