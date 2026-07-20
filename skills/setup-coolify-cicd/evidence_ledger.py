#!/usr/bin/env python3
"""Authenticated, append-only evidence records for cross-run harness delivery."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import tempfile
from typing import Callable


FULL_SHA = re.compile(r"^[0-9a-fA-F]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
LITERAL = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
WORKFLOW_PATH = re.compile(r"^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$")
LANES = {"stage", "production"}
MAX_RECORD_BYTES = 64 * 1024

LOCATOR_FIELDS = {
    "repository", "runId", "artifactId", "artifactName", "fileName", "sha256",
}
PRODUCER_FIELDS = {
    "runId", "runAttempt", "workflowPath", "workflowRef", "sourceRef", "sourceSha", "event",
}
TARGET_FIELDS = {"revision", "ciRunId", "ciWorkflowPath"}
DEPLOYMENT_FIELDS = {
    "schema", "repository", "lane", "provider", "resourceUuid", "revision",
    "deploymentUuid", "healthUrlSha256", "healthVerified", "autoDeployDisabled",
    "sequence", "predecessor", "target", "producer", "outcome",
}
EMPTY_FIELDS = {
    "schema", "repository", "lane", "provider", "resourceUuid", "healthUrlSha256",
    "sequence", "producer", "outcome",
}
BACKEND_FIELDS = {
    "schema", "repository", "lane", "provider", "releaseRevision", "capabilities",
    "sequence", "predecessor", "producer", "outcome",
}
CAPABILITY_FIELDS = {
    "capabilityId", "kind", "provider", "resourceRef", "previousRevision", "backupRef",
    "receiptSha256", "outcome",
}
CONSUMPTION_FIELDS = {
    "schema", "repository", "lane", "applicationRevision", "resourceUuid",
    "deploymentEvidence", "backendEvidence", "sequence", "predecessor", "producer", "outcome",
}


def canonical_json(record: dict) -> bytes:
    return (json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def _exact_mapping(value: object, fields: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} must contain exactly: {', '.join(sorted(fields))}")
    return value


def _positive_int(value: object, label: str, *, allow_zero: bool = False) -> int:
    minimum = 0 if allow_zero else 1
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def _literal(value: object, label: str) -> str:
    if not isinstance(value, str) or not LITERAL.fullmatch(value):
        raise ValueError(f"{label} must be a bounded literal identifier")
    return value


def _full_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or not FULL_SHA.fullmatch(value):
        raise ValueError(f"{label} must be a full Git commit")
    return value.lower()


def _sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def validate_locator(value: object, label: str = "evidence locator") -> dict:
    locator = _exact_mapping(value, LOCATOR_FIELDS, label)
    if not isinstance(locator["repository"], str) or not REPOSITORY.fullmatch(locator["repository"]):
        raise ValueError(f"{label}.repository must be owner/repository")
    _positive_int(locator["runId"], f"{label}.runId")
    _positive_int(locator["artifactId"], f"{label}.artifactId")
    _literal(locator["artifactName"], f"{label}.artifactName")
    if locator["fileName"] != "evidence.json":
        raise ValueError(f"{label}.fileName must be evidence.json")
    _sha256(locator["sha256"], f"{label}.sha256")
    return dict(locator)


def validate_producer(value: object, repository: str) -> dict:
    producer = _exact_mapping(value, PRODUCER_FIELDS, "producer")
    _positive_int(producer["runId"], "producer.runId")
    _positive_int(producer["runAttempt"], "producer.runAttempt")
    path = producer["workflowPath"]
    if not isinstance(path, str) or not WORKFLOW_PATH.fullmatch(path):
        raise ValueError("producer.workflowPath must be a literal workflow path")
    expected_ref = f"{repository}/{path}@refs/heads/main"
    if producer["workflowRef"] != expected_ref:
        raise ValueError("producer.workflowRef must bind the exact workflow to refs/heads/main")
    if producer["sourceRef"] != "refs/heads/main":
        raise ValueError("producer.sourceRef must be refs/heads/main")
    _full_sha(producer["sourceSha"], "producer.sourceSha")
    if producer["event"] not in {"workflow_run", "workflow_dispatch"}:
        raise ValueError("producer.event must be workflow_run or workflow_dispatch")
    return dict(producer)


def _validate_context(record: dict) -> None:
    if not isinstance(record["repository"], str) or not REPOSITORY.fullmatch(record["repository"]):
        raise ValueError("repository must be owner/repository")
    if record["lane"] not in LANES:
        raise ValueError("lane must be stage or production")
    _literal(record["provider"], "provider")
    _literal(record["resourceUuid"], "resourceUuid")
    validate_producer(record["producer"], record["repository"])


def validate_record(record: object) -> dict:
    if not isinstance(record, dict):
        raise ValueError("evidence record must be an object")
    schema = record.get("schema")
    if schema == "deployment-success-v1":
        _exact_mapping(record, DEPLOYMENT_FIELDS, schema)
        _validate_context(record)
        if record["provider"] != "coolify":
            raise ValueError("deployment provider must be coolify")
        _full_sha(record["revision"], "revision")
        _literal(record["deploymentUuid"], "deploymentUuid")
        _sha256(record["healthUrlSha256"], "healthUrlSha256")
        if record["healthVerified"] is not True:
            raise ValueError("deployment health must be verified")
        if record["autoDeployDisabled"] is not True:
            raise ValueError("deployment auto deploy must be disabled")
        _positive_int(record["sequence"], "sequence", allow_zero=True)
        if record["predecessor"] is not None:
            validate_locator(record["predecessor"], "predecessor")
        target = _exact_mapping(record["target"], TARGET_FIELDS, "target")
        if _full_sha(target["revision"], "target.revision") != record["revision"].lower():
            raise ValueError("target revision must equal deployment revision")
        if record["lane"] == "stage":
            _positive_int(target["ciRunId"], "target.ciRunId")
            if target["ciWorkflowPath"] != ".github/workflows/ci.yml":
                raise ValueError("stage target must bind .github/workflows/ci.yml")
        elif target["ciRunId"] is not None or target["ciWorkflowPath"] is not None:
            raise ValueError("production target CI locator fields must be null")
        if record["outcome"] != "deployment-succeeded":
            raise ValueError("deployment outcome must be deployment-succeeded")
    elif schema == "empty-observation-v1":
        _exact_mapping(record, EMPTY_FIELDS, schema)
        _validate_context(record)
        _sha256(record["healthUrlSha256"], "healthUrlSha256")
        if record["sequence"] != 0 or record["outcome"] != "empty-observed":
            raise ValueError("empty observation must be sequence 0 with empty-observed outcome")
    elif schema == "backend-release-v1":
        _exact_mapping(record, BACKEND_FIELDS, schema)
        if record["repository"] is None or not REPOSITORY.fullmatch(record["repository"]):
            raise ValueError("repository must be owner/repository")
        if record["lane"] != "production" or record["provider"] != "aggregate":
            raise ValueError("backend release must use production aggregate provider")
        _full_sha(record["releaseRevision"], "releaseRevision")
        _positive_int(record["sequence"], "sequence", allow_zero=True)
        if record["predecessor"] is not None:
            validate_locator(record["predecessor"], "predecessor")
        validate_producer(record["producer"], record["repository"])
        capabilities = record["capabilities"]
        if not isinstance(capabilities, list) or not capabilities:
            raise ValueError("backend release capabilities must be a non-empty list")
        identifiers = []
        for capability in capabilities:
            _exact_mapping(capability, CAPABILITY_FIELDS, "backend capability receipt")
            identifiers.append(_literal(capability["capabilityId"], "capabilityId"))
            if capability["kind"] not in {"coolify.postgresql", "convex.deployment"}:
                raise ValueError("backend capability kind is not registered")
            _literal(capability["provider"], "capability provider")
            _literal(capability["resourceRef"], "capability resourceRef")
            _literal(capability["previousRevision"], "capability previousRevision")
            _literal(capability["backupRef"], "capability backupRef")
            _sha256(capability["receiptSha256"], "capability receiptSha256")
            if capability["outcome"] != "prepared-expand-only":
                raise ValueError("backend capability outcome must be prepared-expand-only")
        if identifiers != sorted(set(identifiers)):
            raise ValueError("backend capabilities must be unique and sorted by capabilityId")
        if record["outcome"] != "backend-release-succeeded":
            raise ValueError("backend release outcome must be backend-release-succeeded")
    elif schema == "consumption-v1":
        _exact_mapping(record, CONSUMPTION_FIELDS, schema)
        if not REPOSITORY.fullmatch(str(record["repository"])) or record["lane"] != "production":
            raise ValueError("consumption must bind a production repository")
        _full_sha(record["applicationRevision"], "applicationRevision")
        _literal(record["resourceUuid"], "resourceUuid")
        validate_locator(record["deploymentEvidence"], "deploymentEvidence")
        validate_locator(record["backendEvidence"], "backendEvidence")
        _positive_int(record["sequence"], "sequence", allow_zero=True)
        if record["predecessor"] is not None:
            validate_locator(record["predecessor"], "predecessor")
        validate_producer(record["producer"], record["repository"])
        if record["outcome"] != "evidence-consumed":
            raise ValueError("consumption outcome must be evidence-consumed")
    else:
        raise ValueError("unsupported evidence schema")
    return dict(record)


def secure_stage_record(record: dict, path: pathlib.Path) -> None:
    validate_record(record)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError("evidence staging path must not contain a symlink")
    content = canonical_json(record)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise OSError("short evidence write")
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


def bootstrap_empty_observation(*, repository, lane, provider, resource_uuid, health_url, producer):
    record = {
        "schema": "empty-observation-v1",
        "repository": repository,
        "lane": lane,
        "provider": provider,
        "resourceUuid": resource_uuid,
        "healthUrlSha256": hashlib.sha256(health_url.encode()).hexdigest(),
        "sequence": 0,
        "producer": producer,
        "outcome": "empty-observed",
    }
    return validate_record(record)


def bootstrap_import_existing(
    observation: dict,
    *,
    repository: str,
    lane: str,
    resource_uuid: str,
    expected_revision: str,
    health_url: str,
    producer: dict,
) -> dict:
    _full_sha(expected_revision, "expected revision")
    if observation.get("resourceUuid") != resource_uuid:
        raise ValueError("live resource does not match import resource")
    if observation.get("revision") != expected_revision:
        raise ValueError("live revision does not match expected revision")
    if str(observation.get("status", "")).lower() not in {"finished", "success", "completed"}:
        raise ValueError("import requires a successful live deployment")
    if observation.get("autoDeployDisabled") is not True:
        raise ValueError("import requires source auto deploy disabled")
    if observation.get("healthVerified") is not True:
        raise ValueError("import requires verified health")
    health_hash = hashlib.sha256(health_url.encode()).hexdigest()
    if observation.get("healthUrlSha256") != health_hash:
        raise ValueError("import health URL does not match live observation")
    if observation.get("provider") != "coolify":
        raise ValueError("import provider must be coolify")
    record = {
        "schema": "deployment-success-v1",
        "repository": repository,
        "lane": lane,
        "provider": "coolify",
        "resourceUuid": resource_uuid,
        "revision": expected_revision,
        "deploymentUuid": observation.get("deploymentUuid"),
        "healthUrlSha256": health_hash,
        "healthVerified": True,
        "autoDeployDisabled": True,
        "sequence": 0,
        "predecessor": None,
        "target": {
            "revision": expected_revision,
            "ciRunId": 1 if lane == "stage" else None,
            "ciWorkflowPath": ".github/workflows/ci.yml" if lane == "stage" else None,
        },
        "producer": producer,
        "outcome": "deployment-succeeded",
    }
    return validate_record(record)


def authorize_deployment_predecessor(record: dict) -> dict:
    if record.get("schema") != "deployment-success-v1":
        raise ValueError("empty observation cannot authorize deployment or predecessor")
    return validate_record(record)


def derive_rollback_revision(record: dict) -> str:
    if record.get("schema") != "deployment-success-v1":
        raise ValueError("empty observation cannot authorize rollback")
    validate_record(record)
    return _full_sha(record["revision"], "rollback revision")


def validate_successor(previous: dict, previous_locator: dict, candidate: dict) -> None:
    authorize_deployment_predecessor(previous)
    validate_locator(previous_locator)
    validate_record(candidate)
    if candidate.get("schema") != "deployment-success-v1":
        raise ValueError("deployment successor must be deployment-success-v1")
    if candidate["predecessor"] != previous_locator:
        raise ValueError("successor predecessor locator does not match the current head")
    if candidate["sequence"] != previous["sequence"] + 1:
        raise ValueError("successor sequence must increment exactly once")
    for key in ("repository", "lane", "provider", "resourceUuid", "healthUrlSha256"):
        if candidate[key] != previous[key]:
            raise ValueError(f"successor {key} does not match predecessor")


def _locator_key(locator: dict) -> bytes:
    validate_locator(locator)
    return canonical_json(locator)


def resolve_unique_head(entries: list[tuple[dict, dict]]) -> tuple[dict, dict]:
    if not entries:
        raise ValueError("evidence chain has no records")
    records = {}
    child_counts = {}
    for locator, record in entries:
        key = _locator_key(locator)
        if key in records:
            raise ValueError("evidence locator replay detected")
        validate_record(record)
        records[key] = (locator, record)
        predecessor = record.get("predecessor")
        if predecessor is not None:
            predecessor_key = _locator_key(predecessor)
            child_counts[predecessor_key] = child_counts.get(predecessor_key, 0) + 1
            if child_counts[predecessor_key] > 1:
                raise ValueError("evidence chain fork detected")
    referenced = set(child_counts)
    heads = [entry for key, entry in records.items() if key not in referenced]
    if len(heads) != 1:
        raise ValueError("evidence chain must have one unique head")
    return heads[0]


def build_consumption_record(
    *, repository, application_revision, resource_uuid, deployment_evidence,
    backend_evidence, producer, sequence, predecessor,
) -> dict:
    record = {
        "schema": "consumption-v1",
        "repository": repository,
        "lane": "production",
        "applicationRevision": application_revision,
        "resourceUuid": resource_uuid,
        "deploymentEvidence": deployment_evidence,
        "backendEvidence": backend_evidence,
        "sequence": sequence,
        "predecessor": predecessor,
        "producer": producer,
        "outcome": "evidence-consumed",
    }
    return validate_record(record)


def validate_consumption(candidate: dict, prior: list[dict], backend_release: dict) -> None:
    validate_record(candidate)
    validate_record(backend_release)
    if backend_release.get("schema") != "backend-release-v1":
        raise ValueError("consumption requires backend-release-v1")
    if candidate["applicationRevision"] != backend_release["releaseRevision"]:
        raise ValueError("backend release revision does not match application revision")
    backend_key = _locator_key(candidate["backendEvidence"])
    deployment_key = _locator_key(candidate["deploymentEvidence"])
    for record in prior:
        validate_record(record)
        if _locator_key(record["backendEvidence"]) == backend_key or (
            _locator_key(record["backendEvidence"]) == backend_key
            and _locator_key(record["deploymentEvidence"]) == deployment_key
        ):
            raise ValueError("backend evidence replay detected")


def _default_runner(command: list[str], *, cwd: pathlib.Path | None = None) -> str:
    environment = {
        key: value for key, value in os.environ.items()
        if key in {"PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "XDG_CONFIG_HOME"}
    }
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        text=True,
        capture_output=True,
        timeout=120,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise RuntimeError(f"gh command failed: {detail[-1] if detail else 'unknown error'}")
    if len(completed.stdout.encode()) > 2 * 1024 * 1024:
        raise RuntimeError("gh command output exceeds 2 MiB")
    return completed.stdout


class GitHubArtifactAdapter:
    def __init__(
        self,
        *,
        runner: Callable = _default_runner,
        live_readback: Callable[[dict], dict] | None = None,
    ) -> None:
        self.runner = runner
        self.live_readback = live_readback

    def _json_command(self, command: list[str]) -> dict:
        try:
            value = json.loads(self.runner(command, cwd=None))
        except json.JSONDecodeError:
            raise RuntimeError("GitHub metadata command returned invalid JSON") from None
        if not isinstance(value, dict):
            raise RuntimeError("GitHub metadata command must return an object")
        return value

    def resolve(self, locator, *, expected_schema: str, expected_lane: str) -> dict:
        locator = validate_locator(locator)
        repository = locator["repository"]
        artifact = self._json_command([
            "gh", "api", f"repos/{repository}/actions/artifacts/{locator['artifactId']}",
        ])
        if artifact.get("id") != locator["artifactId"] or artifact.get("name") != locator["artifactName"]:
            raise ValueError("artifact metadata does not match immutable locator")
        if artifact.get("expired") is not False:
            raise RuntimeError("evidence artifact is expired or unavailable under retention policy")
        workflow_run = artifact.get("workflow_run")
        if not isinstance(workflow_run, dict) or workflow_run.get("id") != locator["runId"]:
            raise ValueError("artifact metadata is not bound to the requested workflow run")
        run = self._json_command([
            "gh", "api", f"repos/{repository}/actions/runs/{locator['runId']}",
        ])
        if (
            run.get("id") != locator["runId"]
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or run.get("head_branch") != "main"
        ):
            raise ValueError("artifact workflow run is not a successful main-sourced run")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.runner([
                "gh", "run", "download", str(locator["runId"]),
                "--repo", repository,
                "--name", locator["artifactName"],
                "--dir", str(root),
            ], cwd=None)
            files = [path for path in root.rglob("*") if path.is_file() or path.is_symlink()]
            if len(files) != 1 or files[0].name != locator["fileName"] or files[0].is_symlink():
                raise ValueError("downloaded evidence artifact must contain exactly one regular evidence.json")
            raw = files[0].read_bytes()
            if len(raw) > MAX_RECORD_BYTES:
                raise ValueError("downloaded evidence exceeds 64 KiB")
            if hashlib.sha256(raw).hexdigest() != locator["sha256"]:
                raise ValueError("downloaded raw JSON digest does not match locator")
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                raise ValueError("downloaded evidence contains invalid JSON") from None
            validate_record(record)
            if canonical_json(record) != raw:
                raise ValueError("downloaded evidence is not canonical JSON")
            if record["schema"] != expected_schema or record.get("lane") != expected_lane:
                raise ValueError("evidence schema or lane does not match requested context")
            producer = record["producer"]
            if (
                producer["runId"] != run.get("id")
                or producer["runAttempt"] != run.get("run_attempt")
                or producer["sourceSha"] != run.get("head_sha")
                or producer["workflowPath"] != run.get("path")
                or producer["event"] != run.get("event")
            ):
                raise ValueError("evidence producer does not match artifact workflow run metadata")
            self.runner([
                "gh", "attestation", "verify", str(files[0]),
                "--repo", repository,
                "--signer-workflow", producer["workflowRef"],
                "--source-ref", "refs/heads/main",
            ], cwd=None)
        if expected_schema == "deployment-success-v1":
            if self.live_readback is None:
                raise RuntimeError("deployment evidence requires live provider readback")
            live = self.live_readback(record)
            expected_live = {
                "provider": record["provider"],
                "resourceUuid": record["resourceUuid"],
                "revision": record["revision"],
                "deploymentUuid": record["deploymentUuid"],
                "healthUrlSha256": record["healthUrlSha256"],
                "healthVerified": True,
                "autoDeployDisabled": True,
            }
            if live != expected_live:
                raise ValueError("live provider readback does not match deployment evidence")
        return record


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("path")
    args = parser.parse_args()
    if args.command == "validate":
        path = pathlib.Path(args.path)
        raw = path.read_bytes()
        record = json.loads(raw)
        validate_record(record)
        if canonical_json(record) != raw:
            raise ValueError("evidence is not canonical JSON")
        print(json.dumps({"valid": True, "schema": record["schema"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=os.sys.stderr)
        raise SystemExit(2)
