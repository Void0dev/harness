#!/usr/bin/env python3
"""Serialize a Coolify deployment around an exact immutable Git revision."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from coolify_client import AccessPolicy, CoolifyClient, probe_https_health  # noqa: E402


MINIMUM_COOLIFY_VERSION = (4, 1, 2)
FULL_GIT_COMMIT = re.compile(r"^[0-9a-fA-F]{40}$")
RESOURCE_REF = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SUCCESS = {"finished", "success", "completed"}
FAILURE = {"failed", "error", "cancelled", "canceled", "cancelled-by-user", "canceled-by-user"}
SUCCESS_RECORD_FIELDS = frozenset({
    "schemaVersion",
    "recordType",
    "writer",
    "resourceUuid",
    "revision",
    "deploymentUuid",
    "healthUrlSha256",
    "healthVerified",
    "outcome",
})
SUCCESS_RECORD_TYPE = "coolify-exact-deployment"
SUCCESS_RECORD_WRITER = "project-harness/deploy_exact_revision.py"
MAX_EVIDENCE_BYTES = 16 * 1024


class RollbackFailedError(RuntimeError):
    """The requested rollout failed and the compensating rollout also failed."""


def _application_path(api, resource_uuid: str) -> str:
    builder = getattr(api, "literal_path", None)
    return builder("applications", resource_uuid) if builder else f"/applications/{resource_uuid}"


def _deployment_path(api, deployment_uuid: str) -> str:
    builder = getattr(api, "literal_path", None)
    return builder("deployments", deployment_uuid) if builder else f"/deployments/{deployment_uuid}"


def parse_version(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value.strip())
    if not match:
        raise RuntimeError("Coolify returned an unrecognized version")
    return tuple(int(group) for group in match.groups())


def validate_inputs(resource_uuid: str, revision: str) -> None:
    if not RESOURCE_REF.fullmatch(resource_uuid):
        raise ValueError("resource UUID must be a bounded literal identifier")
    if not FULL_GIT_COMMIT.fullmatch(revision):
        raise ValueError("revision must be a full 40-character Git commit")


def validate_successful_deployment_record(
    payload: object,
    resource_uuid: str,
    health_url: str,
) -> dict:
    if not isinstance(payload, dict) or set(payload) != SUCCESS_RECORD_FIELDS:
        raise ValueError("trusted rollback evidence must use the exact successful deployment record contract")
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
        raise ValueError("trusted rollback evidence schemaVersion must be the integer 1")
    if payload.get("recordType") != SUCCESS_RECORD_TYPE or payload.get("writer") != SUCCESS_RECORD_WRITER:
        raise ValueError("trusted rollback evidence has an untrusted record type or writer")
    if payload.get("resourceUuid") != resource_uuid:
        raise ValueError("trusted rollback evidence resource UUID does not match the target resource")
    revision = payload.get("revision")
    if not isinstance(revision, str) or not FULL_GIT_COMMIT.fullmatch(revision):
        raise ValueError("trusted rollback evidence revision must be a full Git commit")
    deployment_uuid = payload.get("deploymentUuid")
    if not isinstance(deployment_uuid, str) or not RESOURCE_REF.fullmatch(deployment_uuid):
        raise ValueError("trusted rollback evidence deployment UUID must be a bounded literal identifier")
    expected_health_hash = hashlib.sha256(health_url.encode()).hexdigest()
    if payload.get("healthUrlSha256") != expected_health_hash:
        raise ValueError("trusted rollback evidence health URL does not match the requested health endpoint")
    if payload.get("healthVerified") is not True or payload.get("outcome") != "deployment-succeeded":
        raise ValueError("trusted rollback evidence must contain a trusted successful outcome with verified health")
    return dict(payload)


def load_successful_deployment_record(
    path: pathlib.Path,
    resource_uuid: str,
    health_url: str,
) -> dict:
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError("trusted rollback evidence path must not contain a symlink")
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        raise RuntimeError("trusted rollback evidence is required before exact deployment") from None
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("trusted rollback evidence must be a regular file")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            raise ValueError("trusted rollback evidence must not be group- or world-writable")
        raw = os.read(descriptor, MAX_EVIDENCE_BYTES + 1)
        if len(raw) > MAX_EVIDENCE_BYTES:
            raise ValueError("trusted rollback evidence exceeds 16 KiB")
    finally:
        os.close(descriptor)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("trusted rollback evidence contains invalid JSON") from None
    return validate_successful_deployment_record(payload, resource_uuid, health_url)


def successful_deployment_record(result: dict) -> dict:
    return {
        "schemaVersion": 1,
        "recordType": SUCCESS_RECORD_TYPE,
        "writer": SUCCESS_RECORD_WRITER,
        "resourceUuid": result["resourceUuid"],
        "revision": result["revision"],
        "deploymentUuid": result["deploymentUuid"],
        "healthUrlSha256": result["healthUrlSha256"],
        "healthVerified": True,
        "outcome": "deployment-succeeded",
    }


def verify_recorded_deployment(deploy_api, evidence: dict) -> None:
    deployment = deploy_api.request(
        "GET", _deployment_path(deploy_api, evidence["deploymentUuid"])
    )
    if not isinstance(deployment, dict):
        raise RuntimeError("trusted rollback deployment lookup must return an object")
    status = str(deployment.get("status", "unknown")).lower()
    if status not in SUCCESS:
        raise RuntimeError("trusted rollback deployment is not in a successful terminal state")
    if deployment.get("commit") != evidence["revision"]:
        raise RuntimeError("trusted rollback deployment commit does not match durable evidence")
    if deployment.get("resource_uuid") != evidence["resourceUuid"]:
        raise RuntimeError("trusted rollback deployment resource does not match durable evidence")


def deploy_exact_revision(
    pin_api,
    resource_uuid: str,
    revision: str,
    health_url: str,
    *,
    health_probe,
    sleep=time.sleep,
    attempts: int = 90,
    interval_seconds: float = 10,
    deploy_api=None,
    rollback_evidence=None,
    record_success=lambda _evidence: None,
    record_event=lambda _evidence: None,
) -> dict:
    deploy_api = deploy_api or pin_api
    validate_inputs(resource_uuid, revision)
    version = pin_api.version()
    if parse_version(version) < MINIMUM_COOLIFY_VERSION:
        raise RuntimeError("exact revision deployment requires Coolify >= 4.1.2")

    if rollback_evidence is None:
        raise RuntimeError("trusted rollback evidence is required before exact deployment")
    rollback_evidence = validate_successful_deployment_record(
        rollback_evidence, resource_uuid, health_url
    )
    verify_recorded_deployment(deploy_api, rollback_evidence)

    application_path = _application_path(pin_api, resource_uuid)
    current_application = pin_api.request("GET", application_path)
    previous_revision = rollback_evidence["revision"]
    if current_application.get("git_commit_sha") != previous_revision:
        raise RuntimeError("current application pin does not match trusted rollback evidence")
    if current_application.get("is_auto_deploy_enabled") is not False:
        raise RuntimeError("current application auto deploy must be disabled before exact deployment")
    evidence = {
        "resourceUuid": resource_uuid,
        "rollbackRevision": previous_revision,
        "rollbackDeploymentUuid": rollback_evidence["deploymentUuid"],
        "targetRevision": revision,
    }
    try:
        result = _rollout_once(
            pin_api,
            deploy_api,
            resource_uuid,
            revision,
            health_url,
            health_probe=health_probe,
            sleep=sleep,
            attempts=attempts,
            interval_seconds=interval_seconds,
        )
    except Exception as original_error:
        if previous_revision == revision:
            record_event({
                **evidence,
                "outcome": "deployment-failed-no-revision-change",
                "deploymentErrorType": type(original_error).__name__,
            })
            raise
        try:
            rollback = _rollout_once(
                pin_api,
                deploy_api,
                resource_uuid,
                previous_revision,
                health_url,
                health_probe=health_probe,
                sleep=sleep,
                attempts=attempts,
                interval_seconds=interval_seconds,
            )
        except Exception as rollback_error:
            record_event({
                **evidence,
                "outcome": "rollback-failed",
                "deploymentErrorType": type(original_error).__name__,
                "rollbackErrorType": type(rollback_error).__name__,
            })
            raise RollbackFailedError(
                "ROLLBACK_FAILED: requested deployment failed and the prior verified revision "
                f"could not be restored; deploymentError={original_error}; rollbackError={rollback_error}"
            ) from None
        record_success(successful_deployment_record(rollback))
        record_event({
            **evidence,
            "outcome": "rollback-succeeded",
            "deploymentErrorType": type(original_error).__name__,
            "rollbackDeploymentUuid": rollback["deploymentUuid"],
        })
        raise RuntimeError(
            f"deployment failed and automatic rollback to {previous_revision} succeeded: {original_error}; "
            f"rollbackDeploymentUuid={rollback['deploymentUuid']}"
        ) from None

    result.update({
        "previousRevision": previous_revision,
        "previousDeploymentUuid": rollback_evidence["deploymentUuid"],
        "coolifyVersion": version,
    })
    record_success(successful_deployment_record(result))
    record_event({
        **evidence,
        "outcome": "deployment-succeeded",
        "deploymentUuid": result["deploymentUuid"],
    })
    return result


def _rollout_once(
    pin_api,
    deploy_api,
    resource_uuid: str,
    revision: str,
    health_url: str,
    *,
    health_probe,
    sleep,
    attempts: int,
    interval_seconds: float,
) -> dict:
    application_path = _application_path(pin_api, resource_uuid)
    pin_api.request("PATCH", application_path, {
        "git_commit_sha": revision,
        "is_auto_deploy_enabled": False,
    })
    pinned = pin_api.request("GET", application_path)
    if pinned.get("git_commit_sha") != revision:
        raise RuntimeError("Coolify did not persist the exact requested git_commit_sha")
    if pinned.get("is_auto_deploy_enabled") is not False:
        raise RuntimeError("Coolify source auto deploy must be disabled before controlled deployment")

    queued = deploy_api.request("POST", "/deploy", {"uuid": resource_uuid})
    deployments = queued.get("deployments") if isinstance(queued, dict) else None
    if not isinstance(deployments, list) or len(deployments) != 1:
        raise RuntimeError("Coolify did not return exactly one queued deployment")
    queued_deployment = deployments[0]
    if not isinstance(queued_deployment, dict) or queued_deployment.get("resource_uuid") != resource_uuid:
        raise RuntimeError("Coolify queued deployment for an unexpected resource")
    deployment_uuid = queued_deployment.get("deployment_uuid")
    if not isinstance(deployment_uuid, str) or not RESOURCE_REF.fullmatch(deployment_uuid):
        raise RuntimeError("Coolify returned an invalid deployment UUID")

    deployment = None
    for _attempt in range(attempts):
        deployment = deploy_api.request("GET", _deployment_path(deploy_api, deployment_uuid))
        status = str(deployment.get("status", "unknown")).lower()
        if status in SUCCESS:
            break
        if status in FAILURE:
            raise RuntimeError(f"Coolify deployment reached failure status: {status}")
        sleep(interval_seconds)
    else:
        raise RuntimeError(f"timed out waiting for Coolify deployment {deployment_uuid}")

    deployed_revision = deployment.get("commit") if isinstance(deployment, dict) else None
    if deployed_revision != revision:
        raise RuntimeError(
            f"Coolify deployed {deployed_revision or 'an unknown commit'}, expected exact revision {revision}"
        )
    final_application = pin_api.request("GET", application_path)
    if final_application.get("git_commit_sha") != revision:
        raise RuntimeError("application revision changed during the serialized deployment")
    if final_application.get("is_auto_deploy_enabled") is not False:
        raise RuntimeError("application auto deploy was re-enabled during the controlled deployment")

    health_probe(health_url)
    return {
        "verified": True,
        "resourceUuid": resource_uuid,
        "deploymentUuid": deployment_uuid,
        "revision": revision,
        "autoDeployEnabled": False,
        "healthUrlSha256": hashlib.sha256(health_url.encode()).hexdigest(),
    }


def durable_json_recorder(path: pathlib.Path):
    """Return a callback that atomically persists bounded non-secret JSON evidence."""
    def record(evidence: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError("deployment evidence path must not contain a symlink")
        payload = (json.dumps(evidence, sort_keys=True, separators=(",", ":")) + "\n").encode()
        temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    raise OSError("short deployment evidence write")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
    return record


@contextlib.contextmanager
def resource_lock(lock_dir: pathlib.Path, resource_uuid: str, timeout_seconds: float = 1800):
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_name = hashlib.sha256(resource_uuid.encode()).hexdigest() + ".lock"
    lock_path = lock_dir / lock_name
    with lock_path.open("a+") as handle:
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"timed out waiting for resource lock {lock_name}") from None
                time.sleep(0.25)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-uuid", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--lock-dir", default=".harness/locks")
    args = parser.parse_args()
    base_url = os.getenv("COOLIFY_URL")
    pin_token = os.getenv("COOLIFY_PIN_TOKEN")
    deploy_token = os.getenv("COOLIFY_DEPLOY_TOKEN")
    if not base_url or not pin_token or not deploy_token:
        raise ValueError("COOLIFY_URL, COOLIFY_PIN_TOKEN, and COOLIFY_DEPLOY_TOKEN are required")
    if pin_token == deploy_token:
        raise ValueError("COOLIFY_PIN_TOKEN and COOLIFY_DEPLOY_TOKEN must be distinct credentials")
    pin_policy = AccessPolicy.from_environment("pin", os.environ, prefix="COOLIFY_PIN_TOKEN")
    deploy_policy = AccessPolicy.from_environment("deploy", os.environ, prefix="COOLIFY_DEPLOY_TOKEN")
    with resource_lock(pathlib.Path(args.lock_dir), args.resource_uuid):
        evidence_path = pathlib.Path(args.lock_dir).parent / "deployment-evidence" / (
            hashlib.sha256(args.resource_uuid.encode()).hexdigest() + ".json"
        )
        event_path = pathlib.Path(args.lock_dir).parent / "deployment-events" / (
            hashlib.sha256(args.resource_uuid.encode()).hexdigest() + ".json"
        )
        rollback_evidence = load_successful_deployment_record(
            evidence_path, args.resource_uuid, args.health_url
        )
        report = deploy_exact_revision(
            CoolifyClient(base_url, pin_token, pin_policy),
            args.resource_uuid,
            args.revision,
            args.health_url,
            health_probe=probe_https_health,
            deploy_api=CoolifyClient(base_url, deploy_token, deploy_policy),
            rollback_evidence=rollback_evidence,
            record_success=durable_json_recorder(evidence_path),
            record_event=durable_json_recorder(event_path),
        )
    report["accessPolicies"] = [pin_policy.evidence(), deploy_policy.evidence()]
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, json.JSONDecodeError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
