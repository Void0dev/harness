#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from agent_evidence_contract import AGENT_INVENTORY_CONTRACT  # noqa: E402
from harness_config import load_config  # noqa: E402


INVENTORY_FIELDS = set(AGENT_INVENTORY_CONTRACT.fields)
CANONICAL_SOURCE = "https://github.com/Void0dev/harness"
IMAGE_PATTERNS = {
    "harnessImage": re.compile(r"^ghcr\.io/void0dev/issue-harness@sha256:[0-9a-f]{64}$"),
    "sandboxImage": re.compile(r"^ghcr\.io/void0dev/sandcastle-harness@sha256:[0-9a-f]{64}$"),
}
FULL_COMMIT = re.compile(r"^[0-9a-f]{40}$")
TRUSTED_SOURCE_REF = re.compile(r"^refs/heads/main$")
CANONICAL_REPOSITORY = "Void0dev/harness"
CANONICAL_WORKFLOW = "Void0dev/harness/.github/workflows/publish-images.yml"
CANONICAL_WORKFLOW_URI = "https://github.com/Void0dev/harness/.github/workflows/publish-images.yml"
PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1"
MAX_PROVENANCE_INPUT_BYTES = 16 * 1024 * 1024
MAX_PROVENANCE_OUTPUT_BYTES = 1024 * 1024
OPERATIONAL_PATHS = {
    "liveness": "/live",
    "readiness": "/ready",
    "identity": "/identity",
    "worker": "/health/worker",
}
MAX_OPERATIONAL_RESPONSE_BYTES = 4096


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_health_origin(origin: str) -> list[str]:
    errors = []
    allow_insecure_loopback = os.environ.get("HARNESS_TEST_ALLOW_INSECURE_LOOPBACK") == "1"
    if not isinstance(origin, str):
        return ["health origin is required"]
    parsed = urllib.parse.urlparse(origin)
    test_loopback = (
        allow_insecure_loopback
        and parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    )
    if parsed.scheme != "https" and not test_loopback:
        errors.append("health origin must use HTTPS")
    if not parsed.hostname:
        errors.append("health origin must include a host")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        errors.append("health origin must not contain userinfo, query, or fragment")
    if parsed.path not in {"", "/"}:
        errors.append("health origin must be an origin without a path")
    try:
        parsed.port
    except ValueError:
        errors.append("health origin has an invalid port")
    return errors


def operational_urls(origin: str) -> dict[str, str]:
    base = origin.rstrip("/")
    return {name: base + path for name, path in OPERATIONAL_PATHS.items()}


def fetch_json_contract(url: str, *, bearer_token: str | None = None) -> dict:
    headers = {"Accept": "application/json"}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirectHandler())
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_OPERATIONAL_RESPONSE_BYTES:
                raise RuntimeError
            raw = response.read(MAX_OPERATIONAL_RESPONSE_BYTES + 1)
            if len(raw) > MAX_OPERATIONAL_RESPONSE_BYTES:
                raise RuntimeError
    except (OSError, RuntimeError, TypeError, ValueError, urllib.error.URLError) as exc:
        raise RuntimeError("operational endpoint request failed") from exc
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("operational endpoint did not return bounded JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("operational endpoint JSON must be an object")
    return payload


def validate_worker_contract(
    worker: object, *, now: datetime.datetime | None = None
) -> list[str]:
    invalid = "worker heartbeat is missing, stale, or malformed"
    if not isinstance(worker, dict) or set(worker) != {
        "schemaVersion",
        "status",
        "lastHeartbeatAt",
        "ageMs",
        "activity",
    }:
        return [invalid]
    if type(worker.get("schemaVersion")) is not int or worker.get("schemaVersion") != 1:
        return [invalid]
    if worker.get("status") != "healthy":
        return [invalid]
    reported_age = worker.get("ageMs")
    if type(reported_age) is not int or reported_age < 0 or reported_age > 180_000:
        return [invalid]
    activity = worker.get("activity")
    if (
        not isinstance(activity, dict)
        or set(activity) != {"poll", "run"}
        or activity.get("poll") not in {"waiting", "polling"}
        or activity.get("run") not in {"idle", "running"}
    ):
        return [invalid]
    heartbeat_value = worker.get("lastHeartbeatAt")
    if not isinstance(heartbeat_value, str):
        return [invalid]
    try:
        heartbeat_at = datetime.datetime.fromisoformat(
            heartbeat_value.replace("Z", "+00:00")
        )
    except ValueError:
        return [invalid]
    if heartbeat_at.tzinfo is None:
        return [invalid]
    current = now or datetime.datetime.now(datetime.timezone.utc)
    if current.tzinfo is None:
        return [invalid]
    heartbeat_age = current.astimezone(datetime.timezone.utc) - heartbeat_at.astimezone(
        datetime.timezone.utc
    )
    if (
        heartbeat_age > datetime.timedelta(minutes=3)
        or heartbeat_age < datetime.timedelta(minutes=-2)
    ):
        return [invalid]
    return []


def _read_regular_file(path: pathlib.Path, label: str, maximum_bytes: int) -> tuple[bytes | None, list[str]]:
    if not hasattr(os, "O_NOFOLLOW"):
        return None, [f"{label} cannot be read safely on this platform"]
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    flags |= os.O_NOFOLLOW
    descriptor = None
    try:
        descriptor = os.open(path, flags)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return None, [f"{label} must be a regular non-symlink file"]
        with os.fdopen(descriptor, "rb", closefd=True) as source:
            descriptor = None
            data = source.read(maximum_bytes + 1)
    except (OSError, ValueError):
        return None, [f"{label} could not be read"]
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if not data or len(data) > maximum_bytes:
        return None, [f"{label} must be non-empty and no larger than {maximum_bytes} bytes"]
    return data, []


def _write_private_file(directory: pathlib.Path, name: str, data: bytes) -> pathlib.Path:
    path = directory / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as destination:
            descriptor = None
            destination.write(data)
            destination.flush()
            os.fsync(destination.fileno())
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    return path


def _verified_attestation_matches(
    record: object,
    *,
    subject: str,
    source_commit: str,
    source_ref: str,
    publication_run_id: str,
) -> bool:
    if not isinstance(record, dict):
        return False
    result = record.get("verificationResult")
    if not isinstance(result, dict):
        return False
    statement = result.get("statement")
    signature = result.get("signature")
    if not isinstance(statement, dict) or not isinstance(signature, dict):
        return False
    certificate = signature.get("certificate")
    subjects = statement.get("subject")
    if not isinstance(certificate, dict) or not isinstance(subjects, list):
        return False
    image_name, digest = subject.rsplit("@sha256:", 1)
    subject_matches = any(
        isinstance(item, dict)
        and item.get("name") == image_name
        and isinstance(item.get("digest"), dict)
        and item["digest"].get("sha256") == digest
        for item in subjects
    )
    expected_workflow_uri = f"{CANONICAL_WORKFLOW_URI}@{source_ref}"
    expected_run_prefix = (
        f"https://github.com/{CANONICAL_REPOSITORY}/actions/runs/{publication_run_id}/attempts/"
    )
    run_uri = certificate.get("runInvocationURI")
    return bool(
        subject_matches
        and certificate.get("sourceRepositoryURI") == CANONICAL_SOURCE
        and certificate.get("sourceRepositoryDigest") == source_commit
        and certificate.get("sourceRepositoryRef") == source_ref
        and certificate.get("githubWorkflowRepository") == CANONICAL_REPOSITORY
        and certificate.get("githubWorkflowRef") == source_ref
        and certificate.get("buildSignerURI") == expected_workflow_uri
        and certificate.get("runnerEnvironment") == "github-hosted"
        and isinstance(run_uri, str)
        and run_uri.startswith(expected_run_prefix)
        and run_uri[len(expected_run_prefix):].isdigit()
    )


def verify_image_attestation(
    *,
    subject: str,
    manifest_path: pathlib.Path,
    bundle_path: pathlib.Path,
    trusted_root_path: pathlib.Path,
    source_commit: str,
    source_ref: str,
    publication_run_id: str,
) -> list[str]:
    errors = []
    pattern = next((value for key, value in IMAGE_PATTERNS.items() if value.fullmatch(subject)), None)
    if pattern is None:
        errors.append("attestation subject must use a canonical image coordinate and digest")
    if not FULL_COMMIT.fullmatch(source_commit):
        errors.append("attestation source commit must be a full lowercase Git commit")
    if not TRUSTED_SOURCE_REF.fullmatch(source_ref):
        errors.append("attestation source ref must be refs/heads/main")
    if not publication_run_id.isdigit():
        errors.append("attestation publication run must be a GitHub Actions run ID")
    manifest, file_errors = _read_regular_file(
        pathlib.Path(manifest_path), "OCI manifest", MAX_PROVENANCE_INPUT_BYTES
    )
    errors.extend(file_errors)
    bundle, bundle_errors = _read_regular_file(
        pathlib.Path(bundle_path), "attestation bundle", MAX_PROVENANCE_INPUT_BYTES
    )
    errors.extend(bundle_errors)
    trusted_root, root_errors = _read_regular_file(
        pathlib.Path(trusted_root_path), "trusted root", MAX_PROVENANCE_INPUT_BYTES
    )
    errors.extend(root_errors)
    if manifest is not None and "@sha256:" in subject:
        expected_digest = subject.rsplit("@sha256:", 1)[1]
        if hashlib.sha256(manifest).hexdigest() != expected_digest:
            errors.append("OCI manifest digest does not match the configured image subject")
    gh = shutil.which("gh")
    if gh is None:
        errors.append("GitHub CLI is required for cryptographic attestation verification")
    if errors:
        return errors

    with tempfile.TemporaryDirectory(prefix="harness-attestation-") as temporary:
        staging_directory = pathlib.Path(temporary)
        os.chmod(staging_directory, 0o700)
        try:
            staged_manifest = _write_private_file(staging_directory, "manifest.json", manifest)
            staged_bundle = _write_private_file(
                staging_directory, "attestation-bundle.jsonl", bundle
            )
            staged_trusted_root = _write_private_file(
                staging_directory, "trusted-root.jsonl", trusted_root
            )
        except OSError:
            return ["cryptographic attestation evidence could not be staged privately"]
        command = [
            gh,
            "attestation",
            "verify",
            str(staged_manifest),
            "--repo",
            CANONICAL_REPOSITORY,
            "--bundle",
            str(staged_bundle),
            "--custom-trusted-root",
            str(staged_trusted_root),
            "--signer-workflow",
            CANONICAL_WORKFLOW,
            "--source-digest",
            source_commit,
            "--source-ref",
            source_ref,
            "--deny-self-hosted-runners",
            "--predicate-type",
            PROVENANCE_PREDICATE,
            "--format",
            "json",
        ]
        environment = {
            "HOME": temporary,
            "GH_CONFIG_DIR": temporary,
            "PATH": os.path.dirname(gh),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }
        try:
            completed = subprocess.run(
                command,
                cwd=temporary,
                env=environment,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.SubprocessError):
            return ["cryptographic attestation verification could not run"]
    if completed.returncode != 0:
        return ["cryptographic attestation verification failed"]
    if len(completed.stdout.encode()) > MAX_PROVENANCE_OUTPUT_BYTES:
        return ["cryptographic attestation verification output was oversized"]
    try:
        verified = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return ["cryptographic attestation verification returned malformed JSON"]
    if not isinstance(verified, list) or not verified:
        return ["cryptographic attestation verification returned no verified statements"]
    if not any(
        _verified_attestation_matches(
            record,
            subject=subject,
            source_commit=source_commit,
            source_ref=source_ref,
            publication_run_id=publication_run_id,
        )
        for record in verified
    ):
        return ["verified attestation does not bind the expected subject, source, workflow, ref, and publication run"]
    return []


def verify_inventory(inventory: object, expected: dict) -> list[str]:
    if not isinstance(inventory, dict):
        return ["Coolify inventory must be a JSON object"]
    errors = AGENT_INVENTORY_CONTRACT.validate(inventory)
    mismatches = [key for key, value in expected.items() if inventory.get(key) != value]
    if mismatches:
        errors.append("Coolify inventory mismatch: " + ", ".join(mismatches))
    if (
        inventory.get("rolloutHarnessImage") != inventory.get("harnessImage")
        or inventory.get("rolloutSandboxImage") != inventory.get("sandboxImage")
        or inventory.get("rolloutStatus") != "running"
    ):
        errors.append("rollout evidence must show both verified image subjects running")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    parser.add_argument("--offline", action="store_true", help="validate configuration without claiming online health")
    parser.add_argument("--health-origin")
    parser.add_argument("--inventory-json", help="fresh non-secret Coolify deployment inventory for online verification")
    parser.add_argument("--harness-manifest", help="downloaded OCI index manifest for the harness image")
    parser.add_argument("--sandbox-manifest", help="downloaded OCI index manifest for the sandbox image")
    parser.add_argument("--harness-attestation-bundle", help="downloaded GitHub attestation bundle for the harness image")
    parser.add_argument("--sandbox-attestation-bundle", help="downloaded GitHub attestation bundle for the sandbox image")
    parser.add_argument("--trusted-root", help="fresh GitHub/Sigstore trusted_root.jsonl")
    parser.add_argument(
        "--source-ref",
        help="trusted publication source; only refs/heads/main is accepted",
    )
    args = parser.parse_args()
    root = pathlib.Path(args.repo).resolve()
    _, config = load_config(root)
    issue = config.get("issueAgent", {})
    errors = []
    if issue.get("baseBranch") != "stage":
        errors.append("issueAgent.baseBranch must be 'stage'")
    if not issue.get("applicationUuid"):
        errors.append("issueAgent.applicationUuid is unbound")
    for key, pattern in IMAGE_PATTERNS.items():
        image = issue.get(key, "")
        if not isinstance(image, str) or not pattern.fullmatch(image):
            errors.append(f"issueAgent.{key} must use its canonical coordinate and lowercase sha256 digest")
    if issue.get("imageSourceRepository") != CANONICAL_SOURCE:
        errors.append("issueAgent.imageSourceRepository must be the canonical harness repository")
    if not isinstance(issue.get("imageSourceCommit"), str) or not FULL_COMMIT.fullmatch(issue["imageSourceCommit"]):
        errors.append("issueAgent.imageSourceCommit must be a full lowercase Git commit")
    if not isinstance(issue.get("imagePublicationRunId"), str) or not issue["imagePublicationRunId"].isdigit():
        errors.append("issueAgent.imagePublicationRunId must be a GitHub Actions run ID")
    if not (root / ".sandcastle" / "prompt.md").is_file():
        errors.append("missing .sandcastle/prompt.md")
    if not (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").is_file():
        errors.append("missing .github/ISSUE_TEMPLATE/agent-task.yml")
    if issue.get("dedicatedAutomationHost") is not True:
        errors.append("issueAgent.dedicatedAutomationHost must be true for the sandbox engine")
    if issue.get("sandboxEngineMode") not in {"rootless-local", "remote-tls"}:
        errors.append("issueAgent.sandboxEngineMode must be rootless-local or remote-tls")
    if not issue.get("serverUuid"):
        errors.append("issueAgent.serverUuid is required")
    elif issue.get("serverUuid") == config.get("coolify", {}).get("serverUuid"):
        errors.append("issueAgent.serverUuid must differ from the application server UUID")
    data_dir = issue.get("dataDir", "")
    data_path = pathlib.PurePosixPath(data_dir)
    if (
        not data_dir.startswith("/opt/issue-harness/")
        or ".." in data_path.parts
        or len(data_path.parts) < 4
    ):
        errors.append("issueAgent.dataDir must be a per-repository child of /opt/issue-harness")
    if issue.get("maxConcurrentRuns", 1) != 1 or issue.get("replicas", 1) != 1:
        errors.append("issueAgent maxConcurrentRuns and replicas must both be 1")

    inventory_verified = False
    provenance_verified = False
    if not args.offline:
        if not args.inventory_json:
            errors.append("online verification requires --inventory-json from a fresh Coolify inventory")
        else:
            inventory = json.loads(pathlib.Path(args.inventory_json).read_text())
            expected_inventory = {
                "applicationUuid": issue.get("applicationUuid"),
                "serverUuid": issue.get("serverUuid"),
                "harnessImage": issue.get("harnessImage"),
                "sandboxImage": issue.get("sandboxImage"),
                "dataDir": issue.get("dataDir"),
                "replicas": 1,
            }
            inventory_errors = verify_inventory(inventory, expected_inventory)
            errors.extend(inventory_errors)
            inventory_verified = not inventory_errors
        provenance_arguments = {
            "harnessImage": (args.harness_manifest, args.harness_attestation_bundle),
            "sandboxImage": (args.sandbox_manifest, args.sandbox_attestation_bundle),
        }
        if not args.trusted_root or not args.source_ref or any(
            manifest is None or bundle is None
            for manifest, bundle in provenance_arguments.values()
        ):
            errors.append(
                "online verification requires both OCI manifests, both attestation bundles, --trusted-root, and --source-ref"
            )
        else:
            provenance_errors = []
            for image_key, (manifest, bundle) in provenance_arguments.items():
                provenance_errors.extend(verify_image_attestation(
                    subject=issue.get(image_key, ""),
                    manifest_path=pathlib.Path(manifest),
                    bundle_path=pathlib.Path(bundle),
                    trusted_root_path=pathlib.Path(args.trusted_root),
                    source_commit=issue.get("imageSourceCommit", ""),
                    source_ref=args.source_ref,
                    publication_run_id=issue.get("imagePublicationRunId", ""),
                ))
            errors.extend(provenance_errors)
            provenance_verified = not provenance_errors

    liveness_verified = False
    readiness_verified = False
    identity_verified = False
    worker_verified = False
    urls = operational_urls(args.health_origin) if args.health_origin else {}
    health_token = os.environ.get("AGENT_HEALTH_TOKEN")
    if args.offline:
        if args.health_origin:
            errors.append("offline verification cannot accept a health origin")
    elif not args.health_origin:
        errors.append("online verification requires --health-origin")
    else:
        errors.extend(validate_health_origin(args.health_origin))
        if not health_token:
            errors.append("online identity verification requires AGENT_HEALTH_TOKEN")
    if not args.offline and args.health_origin and health_token and not validate_health_origin(args.health_origin):
        def read_contract(name: str, *, bearer_token: str | None = None):
            try:
                return fetch_json_contract(urls[name], bearer_token=bearer_token)
            except RuntimeError:
                errors.append(f"{name} operational contract request failed")
                return None

        liveness = read_contract("liveness")
        if liveness is not None and (set(liveness) != {"status"} or liveness.get("status") != "alive"):
            errors.append("liveness contract is not alive")
        elif liveness is not None:
            liveness_verified = True

        readiness = read_contract("readiness")
        if readiness is not None and (set(readiness) != {"status"} or readiness.get("status") != "ready"):
            errors.append("readiness contract is not ready")
        elif readiness is not None:
            readiness_verified = True

        identity = read_contract("identity", bearer_token=health_token)
        expected = config.get("project", {}).get("github")
        expected_origin = f"https://github.com/{expected}.git"
        if identity is not None and (
            set(identity) != {"repository", "workspaceOrigin"}
            or identity.get("repository") != expected
            or identity.get("workspaceOrigin") != expected_origin
        ):
            errors.append("identity response does not match the target repository")
        elif identity is not None:
            identity_verified = True

        worker = read_contract("worker")
        worker_errors = validate_worker_contract(worker)
        if worker_errors:
            errors.extend(worker_errors)
        else:
            worker_verified = True
    health_verified = liveness_verified and readiness_verified and identity_verified and worker_verified
    print(json.dumps({
        "verified": not errors,
        "healthVerified": health_verified,
        "livenessVerified": liveness_verified,
        "readinessVerified": readiness_verified,
        "identityVerified": identity_verified,
        "workerVerified": worker_verified,
        "inventoryVerified": inventory_verified,
        "provenanceVerified": provenance_verified,
        "errors": errors,
    }, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
