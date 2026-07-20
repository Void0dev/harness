import pathlib
import re
import stat
import subprocess
import tempfile
import unittest


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
    def test_docker_build_context_excludes_runtime_and_credential_material(self):
        patterns = {
            line.strip()
            for line in (ROOT / ".dockerignore").read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        required = {
            ".omx",
            ".harness",
            ".sandcastle/*",
            "!.sandcastle/Dockerfile",
            "!.sandcastle/prompt.md",
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
            ".harness/codex/auth.json",
            ".harness/locks/deploy.lock",
            ".omx/state/ultragoal.json",
            "credentials/client.key",
            "credentials/client.pem",
            "credentials/client.p12",
            "credentials/client.pfx",
            ".npmrc",
            "services/example/.netrc",
            ".docker/config.json",
            "secrets/id_rsa",
            "secrets/id_ed25519",
            ".sandcastle/logs/issue-1.log",
            ".sandcastle/worktrees/issue-1/.git",
            ".sandcastle/sandboxes/issue-1.json",
            ".env.production",
            "services/example/.env.local",
        ]

        for candidate in runtime_paths:
            with self.subTest(candidate=candidate):
                result = git("check-ignore", "--no-index", "-q", candidate)
                self.assertEqual(result.returncode, 0, candidate)

    def test_declarative_contract_and_reviewed_helpers_remain_trackable(self):
        trackable_paths = [
            ".harness/config.json",
            ".harness/coolify_client.py",
            ".harness/deploy_exact_revision.py",
            ".harness/evidence_ledger.py",
            ".env.example",
            "services/example/.env.example",
            ".sandcastle/Dockerfile",
            ".sandcastle/prompt.md",
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
            ".harness/coolify_client.py",
            ".harness/deploy_exact_revision.py",
            ".harness/evidence_ledger.py",
        }
        forbidden = []
        for filename in tracked:
            path = pathlib.PurePosixPath(filename)
            if filename.startswith(".harness/") and filename not in allowed_harness:
                forbidden.append(filename)
            if filename.startswith((
                ".sandcastle/logs/",
                ".sandcastle/worktrees/",
                ".sandcastle/sandboxes/",
            )):
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
            content = (ROOT / filename).read_bytes()
            if b"\0" in content:
                continue
            for label, pattern in SECRET_PATTERNS.items():
                if pattern.search(content):
                    findings.append(f"{filename}: {label}")

        self.assertEqual(findings, [])

    def test_runtime_permissions_are_private_and_certificate_files_are_owner_only(self):
        runtime_directories = [
            "logs",
            "state",
            "sandboxes",
            "workspaces",
            "sandcastle",
            "runs",
            "artifacts",
            "publishers",
            "docker-certs",
        ]
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = pathlib.Path(temporary) / "repository"
            for relative in runtime_directories:
                directory = data_dir / relative
                directory.mkdir(parents=True, mode=0o755)
                directory.chmod(0o755)
            for certificate in ("ca.pem", "cert.pem", "key.pem"):
                path = data_dir / "docker-certs" / certificate
                path.write_text("synthetic test certificate")
                path.chmod(0o644)

            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    (
                        "source services/issue-harness/runtime_permissions.sh; "
                        'harden_harness_runtime "$1" "$(id -u):$(id -g)"'
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

            for relative in runtime_directories:
                with self.subTest(directory=relative):
                    mode = stat.S_IMODE((data_dir / relative).stat().st_mode)
                    self.assertEqual(mode, 0o700)
            for certificate in ("ca.pem", "cert.pem", "key.pem"):
                with self.subTest(certificate=certificate):
                    mode = stat.S_IMODE((data_dir / "docker-certs" / certificate).stat().st_mode)
                    self.assertEqual(mode, 0o600)

    def test_runtime_hardening_rejects_symlinked_certificate_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = pathlib.Path(temporary) / "repository"
            certificates = data_dir / "docker-certs"
            certificates.mkdir(parents=True)
            target = pathlib.Path(temporary) / "outside-key.pem"
            target.write_text("outside secret")
            (certificates / "key.pem").symlink_to(target)

            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    (
                        "source services/issue-harness/runtime_permissions.sh; "
                        'harden_harness_runtime "$1" "$(id -u):$(id -g)"'
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
            self.assertEqual(target.read_text(), "outside secret")


if __name__ == "__main__":
    unittest.main()
