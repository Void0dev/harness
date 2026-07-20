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
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Callable


FULL_SHA = re.compile(r"^[0-9a-fA-F]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
LITERAL = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
WORKFLOW_PATH = re.compile(r"^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$")
LANES = {"stage", "production"}
MAX_RECORD_BYTES = 64 * 1024
MAX_GITHUB_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_ARTIFACTS = 1000
SUCCESS_STATUSES = {"finished", "success", "completed"}
CHECKPOINT_RETENTION = timedelta(days=89)
MAX_CHECKPOINT_RETENTION = timedelta(days=90)
RFC3339_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

ENVELOPE_FIELDS = {"locator", "record"}
DEPLOY_SUCCESS_FIELDS = {
    "schemaVersion", "recordType", "writer", "resourceUuid", "revision",
    "deploymentUuid", "healthUrlSha256", "healthVerified", "outcome",
}
TRUSTED_WORKFLOWS = {
    "deployment-success-v1": {
        ".github/workflows/coolify-deploy.yml",
        ".github/workflows/coolify-rollback.yml",
        ".github/workflows/bootstrap-deployment-evidence.yml",
    },
    "empty-observation-v1": {".github/workflows/bootstrap-deployment-evidence.yml"},
    "backend-release-v1": {".github/workflows/backend-prepare.yml"},
    "consumption-v1": {".github/workflows/coolify-deploy.yml"},
    "retention-checkpoint-v1": {
        ".github/workflows/evidence-retention-checkpoint.yml",
    },
}

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
CHECKPOINT_FIELDS = {
    "schema", "repository", "lane", "provider", "resourceUuid", "revision",
    "deploymentUuid", "healthUrlSha256", "healthVerified", "autoDeployDisabled",
    "epoch", "sequence", "supersededHead", "supersededHeadSha256", "createdAt",
    "expiresAt", "target", "producer", "outcome",
}
DELIVERY_HEAD_SCHEMAS = {"deployment-success-v1", "retention-checkpoint-v1"}


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


def _rfc3339_utc(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not RFC3339_UTC.fullmatch(value):
        raise ValueError(f"{label} must be an RFC-3339 UTC timestamp with second precision")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"{label} must be an RFC-3339 UTC timestamp with second precision") from None
    return parsed.astimezone(timezone.utc)


def _format_rfc3339_utc(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("checkpoint time must be timezone-aware")
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
        if (record["sequence"] == 0) != (record["predecessor"] is None):
            raise ValueError("deployment sequence 0 must have no predecessor and later records must have one")
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
        if (record["sequence"] == 0) != (record["predecessor"] is None):
            raise ValueError("backend sequence 0 must have no predecessor and later records must have one")
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
        if (record["sequence"] == 0) != (record["predecessor"] is None):
            raise ValueError("consumption sequence 0 must have no predecessor and later records must have one")
        validate_producer(record["producer"], record["repository"])
        if record["outcome"] != "evidence-consumed":
            raise ValueError("consumption outcome must be evidence-consumed")
    elif schema == "retention-checkpoint-v1":
        _exact_mapping(record, CHECKPOINT_FIELDS, schema)
        _validate_context(record)
        if record["provider"] != "coolify":
            raise ValueError("retention checkpoint provider must be coolify")
        _full_sha(record["revision"], "checkpoint revision")
        _literal(record["deploymentUuid"], "checkpoint deploymentUuid")
        _sha256(record["healthUrlSha256"], "checkpoint healthUrlSha256")
        if record["healthVerified"] is not True or record["autoDeployDisabled"] is not True:
            raise ValueError("retention checkpoint must prove verified health and disabled auto deploy")
        _positive_int(record["epoch"], "checkpoint epoch")
        if record["sequence"] != 0:
            raise ValueError("retention checkpoint sequence must be 0")
        superseded = validate_locator(record["supersededHead"], "checkpoint supersededHead")
        if record["supersededHeadSha256"] != superseded["sha256"]:
            raise ValueError("checkpoint superseded head digest must equal its immutable locator digest")
        created = _rfc3339_utc(record["createdAt"], "checkpoint createdAt")
        expires = _rfc3339_utc(record["expiresAt"], "checkpoint expiresAt")
        if not created < expires <= created + MAX_CHECKPOINT_RETENTION:
            raise ValueError("retention checkpoint expiry must be after creation and at most 90 days later")
        target = _exact_mapping(record["target"], TARGET_FIELDS, "checkpoint target")
        if _full_sha(target["revision"], "checkpoint target.revision") != record["revision"].lower():
            raise ValueError("checkpoint target revision must equal checkpoint revision")
        if record["lane"] == "stage":
            _positive_int(target["ciRunId"], "checkpoint target.ciRunId")
            if target["ciWorkflowPath"] != ".github/workflows/ci.yml":
                raise ValueError("stage checkpoint target must bind .github/workflows/ci.yml")
        elif target["ciRunId"] is not None or target["ciWorkflowPath"] is not None:
            raise ValueError("production checkpoint target CI locator fields must be null")
        if record["outcome"] != "retention-checkpointed":
            raise ValueError("retention checkpoint outcome must be retention-checkpointed")
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
    if record.get("schema") not in DELIVERY_HEAD_SCHEMAS:
        raise ValueError("empty observation cannot authorize deployment or predecessor")
    return validate_record(record)


def derive_rollback_revision(record: dict) -> str:
    if record.get("schema") not in DELIVERY_HEAD_SCHEMAS:
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


def build_retention_checkpoint(
    head_locator: dict,
    head_record: dict,
    *,
    producer: dict,
    now: datetime | None = None,
    epoch: int = 1,
) -> dict:
    locator = validate_locator(head_locator, "checkpoint current head")
    head = authorize_deployment_predecessor(head_record)
    if head["repository"] != locator["repository"]:
        raise ValueError("checkpoint current head repository does not match locator")
    if producer.get("workflowPath") != ".github/workflows/evidence-retention-checkpoint.yml":
        raise ValueError("retention checkpoint must be produced by the reviewed checkpoint workflow")
    _positive_int(epoch, "checkpoint epoch")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    record = {
        "schema": "retention-checkpoint-v1",
        "repository": head["repository"],
        "lane": head["lane"],
        "provider": "coolify",
        "resourceUuid": head["resourceUuid"],
        "revision": head["revision"],
        "deploymentUuid": head["deploymentUuid"],
        "healthUrlSha256": head["healthUrlSha256"],
        "healthVerified": True,
        "autoDeployDisabled": True,
        "epoch": epoch,
        "sequence": 0,
        "supersededHead": locator,
        "supersededHeadSha256": locator["sha256"],
        "createdAt": _format_rfc3339_utc(current),
        "expiresAt": _format_rfc3339_utc(current + CHECKPOINT_RETENTION),
        "target": head["target"],
        "producer": producer,
        "outcome": "retention-checkpointed",
    }
    return validate_record(record)


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
    for locator, record in entries:
        predecessor = record.get("predecessor")
        if predecessor is None:
            continue
        predecessor_key = _locator_key(predecessor)
        if predecessor_key not in records:
            raise ValueError("evidence chain contains a dangling predecessor locator")
        parent_locator, parent = records[predecessor_key]
        if record["schema"] != parent["schema"]:
            raise ValueError("evidence chain schemas must not change")
        if record["schema"] == "deployment-success-v1":
            validate_successor(parent, parent_locator, record)
        else:
            if record["sequence"] != parent["sequence"] + 1:
                raise ValueError("evidence successor sequence must increment exactly once")
            if record["predecessor"] != parent_locator:
                raise ValueError("evidence successor predecessor does not match its parent")
            for field in ("repository", "lane"):
                if record[field] != parent[field]:
                    raise ValueError(f"evidence successor {field} does not match predecessor")
            if record["schema"] == "consumption-v1" and record["resourceUuid"] != parent["resourceUuid"]:
                raise ValueError("consumption successor resourceUuid does not match predecessor")
    referenced = set(child_counts)
    heads = [entry for key, entry in records.items() if key not in referenced]
    if len(heads) != 1:
        raise ValueError("evidence chain must have one unique head")
    return heads[0]


def _delivery_parent_locator(record: dict) -> dict | None:
    if record["schema"] == "deployment-success-v1":
        return record["predecessor"]
    if record["schema"] == "retention-checkpoint-v1":
        return record["supersededHead"]
    raise ValueError("record is not delivery evidence")


def _delivery_context_matches(left: dict, right: dict) -> bool:
    return all(
        left[field] == right[field]
        for field in (
            "repository", "lane", "provider", "resourceUuid", "revision",
            "deploymentUuid", "healthUrlSha256", "healthVerified", "autoDeployDisabled",
        )
    )


def resolve_current_delivery_head(
    entries: list[tuple[dict, dict]],
    *,
    now: datetime | None = None,
) -> tuple[dict, dict]:
    """Resolve one active delivery head, allowing retention checkpoints to re-root history."""
    if not entries:
        raise ValueError("delivery evidence chain has no records")
    records: dict[bytes, tuple[dict, dict]] = {}
    for locator, record in entries:
        key = _locator_key(locator)
        if key in records:
            raise ValueError("delivery evidence locator replay detected")
        validate_record(record)
        if record["schema"] not in DELIVERY_HEAD_SCHEMAS:
            raise ValueError("delivery head resolution accepts deployment or retention checkpoint evidence only")
        records[key] = (locator, record)

    def mark_obsolete(key: bytes, marked: set[bytes]) -> None:
        if key in marked or key not in records:
            return
        marked.add(key)
        _locator, record = records[key]
        parent = _delivery_parent_locator(record)
        if parent is not None:
            mark_obsolete(_locator_key(parent), marked)

    obsolete: set[bytes] = set()
    for _locator, record in records.values():
        if record["schema"] == "retention-checkpoint-v1":
            superseded_key = _locator_key(record["supersededHead"])
            if superseded_key in records:
                _old_locator, old_record = records[superseded_key]
                if not _delivery_context_matches(record, old_record):
                    raise ValueError("retention checkpoint does not match the superseded delivery head context")
            mark_obsolete(superseded_key, obsolete)

    active = {key: value for key, value in records.items() if key not in obsolete}
    if not active:
        raise ValueError("retention checkpoints cannot supersede every delivery record")

    def epoch_for(key: bytes, seen: set[bytes] | None = None) -> int:
        if key not in records:
            return 0
        seen = seen or set()
        if key in seen:
            raise ValueError("delivery evidence ancestry contains a cycle")
        seen.add(key)
        _locator, record = records[key]
        if record["schema"] == "retention-checkpoint-v1":
            return record["epoch"]
        parent = record["predecessor"]
        return 0 if parent is None else epoch_for(_locator_key(parent), seen)

    child_counts: dict[bytes, int] = {}
    for key, (_locator, record) in active.items():
        if record["schema"] == "retention-checkpoint-v1":
            superseded_key = _locator_key(record["supersededHead"])
            if superseded_key in records and record["epoch"] != epoch_for(superseded_key) + 1:
                raise ValueError("retention checkpoint epoch must increment the superseded head epoch")
            continue
        predecessor = record["predecessor"]
        if predecessor is None:
            continue
        parent_key = _locator_key(predecessor)
        if parent_key not in active:
            raise ValueError("active delivery record has a missing or superseded predecessor")
        parent_locator, parent = active[parent_key]
        validate_successor(parent, parent_locator, record)
        child_counts[parent_key] = child_counts.get(parent_key, 0) + 1
        if child_counts[parent_key] > 1:
            raise ValueError("active delivery evidence chain fork detected")

    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    for _key, (_locator, record) in active.items():
        if record["schema"] == "retention-checkpoint-v1" and current >= _rfc3339_utc(record["expiresAt"], "checkpoint expiresAt"):
            raise ValueError("retention checkpoint is expired and must be recovered before use")
    heads = [entry for key, entry in active.items() if key not in child_counts]
    if len(heads) != 1:
        raise ValueError("delivery evidence must have one unique current head")
    return heads[0]


def delivery_head_epoch(entries: list[tuple[dict, dict]], head_locator: dict) -> int:
    records = {_locator_key(locator): record for locator, record in entries}
    key = _locator_key(head_locator)
    seen: set[bytes] = set()
    while key in records:
        if key in seen:
            raise ValueError("delivery evidence ancestry contains a cycle")
        seen.add(key)
        record = records[key]
        if record["schema"] == "retention-checkpoint-v1":
            return record["epoch"]
        predecessor = record["predecessor"]
        if predecessor is None:
            return 0
        key = _locator_key(predecessor)
    return 0


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


def validate_capability_receipt(value: object) -> dict:
    receipt = _exact_mapping(value, CAPABILITY_FIELDS, "backend capability receipt")
    capability_id = _literal(receipt["capabilityId"], "capabilityId")
    contracts = {
        "postgres": ("coolify.postgresql", "coolify-postgresql"),
        "convex": ("convex.deployment", "convex"),
    }
    if capability_id not in contracts:
        raise ValueError("backend capability receipt is not registered")
    expected_kind, expected_provider = contracts[capability_id]
    if receipt["kind"] != expected_kind or receipt["provider"] != expected_provider:
        raise ValueError("backend capability receipt kind or provider is not canonical")
    _literal(receipt["resourceRef"], "capability resourceRef")
    _literal(receipt["previousRevision"], "capability previousRevision")
    _literal(receipt["backupRef"], "capability backupRef")
    _sha256(receipt["receiptSha256"], "capability receiptSha256")
    if receipt["outcome"] != "prepared-expand-only":
        raise ValueError("backend capability receipt outcome must be prepared-expand-only")
    return dict(receipt)


def validate_deploy_success_record(
    value: object,
    *,
    resource_uuid: str | None = None,
    health_url: str | None = None,
) -> dict:
    record = _exact_mapping(value, DEPLOY_SUCCESS_FIELDS, "local exact-deployment record")
    if type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1:
        raise ValueError("local exact-deployment record schemaVersion must be integer 1")
    if (
        record["recordType"] != "coolify-exact-deployment"
        or record["writer"] != "project-harness/deploy_exact_revision.py"
    ):
        raise ValueError("local exact-deployment record writer contract is invalid")
    _literal(record["resourceUuid"], "local deployment resourceUuid")
    _full_sha(record["revision"], "local deployment revision")
    _literal(record["deploymentUuid"], "local deployment deploymentUuid")
    _sha256(record["healthUrlSha256"], "local deployment healthUrlSha256")
    if record["healthVerified"] is not True or record["outcome"] != "deployment-succeeded":
        raise ValueError("local exact-deployment record must prove successful verified health")
    if resource_uuid is not None and record["resourceUuid"] != resource_uuid:
        raise ValueError("local exact-deployment record resource does not match")
    if health_url is not None and record["healthUrlSha256"] != hashlib.sha256(health_url.encode()).hexdigest():
        raise ValueError("local exact-deployment record health URL does not match")
    return dict(record)


def deployment_to_local_record(record: dict) -> dict:
    authorize_deployment_predecessor(record)
    return validate_deploy_success_record({
        "schemaVersion": 1,
        "recordType": "coolify-exact-deployment",
        "writer": "project-harness/deploy_exact_revision.py",
        "resourceUuid": record["resourceUuid"],
        "revision": record["revision"],
        "deploymentUuid": record["deploymentUuid"],
        "healthUrlSha256": record["healthUrlSha256"],
        "healthVerified": True,
        "outcome": "deployment-succeeded",
    })


def _bounded_path(value: object, label: str) -> pathlib.Path:
    if not isinstance(value, (str, os.PathLike)):
        raise ValueError(f"{label} must be a filesystem path")
    text = os.fspath(value)
    if not text or len(text) > 4096 or "\x00" in text:
        raise ValueError(f"{label} must be a bounded filesystem path")
    return pathlib.Path(text)


def read_canonical_json(path_value: object, *, label: str, limit: int = MAX_RECORD_BYTES) -> object:
    path = _bounded_path(path_value, label)
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError(f"{label} path must not contain a symlink")
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"{label} must be a regular file")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            raise ValueError(f"{label} must not be group- or world-writable")
        raw = os.read(descriptor, limit + 1)
    finally:
        os.close(descriptor)
    if len(raw) > limit:
        raise ValueError(f"{label} exceeds its byte limit")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError(f"{label} contains invalid JSON") from None
    if canonical_json(value) != raw:
        raise ValueError(f"{label} must use canonical JSON bytes")
    return value


def write_canonical_json(value: dict, path_value: object) -> None:
    path = _bounded_path(path_value, "output")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError("output path must not contain a symlink")
    raw = canonical_json(value)
    if len(raw) > MAX_RECORD_BYTES:
        raise ValueError("output exceeds 64 KiB")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
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


def validate_envelope(value: object, *, schema: str | None = None, lane: str | None = None) -> dict:
    envelope = _exact_mapping(value, ENVELOPE_FIELDS, "resolved evidence envelope")
    locator = validate_locator(envelope["locator"])
    record = validate_record(envelope["record"])
    if hashlib.sha256(canonical_json(record)).hexdigest() != locator["sha256"]:
        raise ValueError("resolved evidence envelope locator digest does not match record bytes")
    if record["repository"] != locator["repository"]:
        raise ValueError("resolved evidence envelope repository does not match locator")
    allowed_schemas = (
        DELIVERY_HEAD_SCHEMAS | {"empty-observation-v1"}
        if schema == "bootstrap-evidence-v1"
        else DELIVERY_HEAD_SCHEMAS if schema == "delivery-head-v1" else {schema}
    )
    if schema is not None and record["schema"] not in allowed_schemas:
        raise ValueError("resolved evidence envelope schema does not match")
    if lane is not None and record.get("lane") != lane:
        raise ValueError("resolved evidence envelope lane does not match")
    return {"locator": locator, "record": record}


def load_envelope(path_value: object, *, schema: str | None = None, lane: str | None = None) -> dict:
    return validate_envelope(
        read_canonical_json(path_value, label="resolved evidence envelope"),
        schema=schema,
        lane=lane,
    )


def load_record_or_envelope(path_value: object) -> tuple[dict | None, dict]:
    value = read_canonical_json(path_value, label="evidence")
    if isinstance(value, dict) and set(value) == ENVELOPE_FIELDS:
        envelope = validate_envelope(value)
        return envelope["locator"], envelope["record"]
    return None, validate_record(value)


def producer_from_environment(expected_workflows: set[str]) -> dict:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("GITHUB_REPOSITORY must be owner/repository")
    workflow_ref = os.environ.get("GITHUB_WORKFLOW_REF", "")
    prefix = repository + "/"
    suffix = "@refs/heads/main"
    if not workflow_ref.startswith(prefix) or not workflow_ref.endswith(suffix):
        raise ValueError("GITHUB_WORKFLOW_REF must bind a trusted workflow on refs/heads/main")
    workflow_path = workflow_ref[len(prefix):-len(suffix)]
    if workflow_path not in expected_workflows:
        raise ValueError("GITHUB_WORKFLOW_REF is not an allowed producer workflow")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("GITHUB_REF must be refs/heads/main")
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    producer = {
        "runId": _positive_int_from_text(os.environ.get("GITHUB_RUN_ID"), "GITHUB_RUN_ID"),
        "runAttempt": _positive_int_from_text(
            os.environ.get("GITHUB_RUN_ATTEMPT"), "GITHUB_RUN_ATTEMPT"
        ),
        "workflowPath": workflow_path,
        "workflowRef": workflow_ref,
        "sourceRef": "refs/heads/main",
        "sourceSha": _full_sha(os.environ.get("GITHUB_SHA"), "GITHUB_SHA"),
        "event": event,
    }
    return validate_producer(producer, repository)


def _positive_int_from_text(value: object, label: str) -> int:
    if not isinstance(value, str) or not value.isdigit() or len(value) > 20:
        raise ValueError(f"{label} must be a positive integer")
    return _positive_int(int(value), label)


def _report(command: str, **fields: object) -> None:
    print(json.dumps({"command": command, "ok": True, **fields}, sort_keys=True, separators=(",", ":")))


def _run_path_matches_main(run_path: object, workflow_path: str) -> bool:
    return run_path in {
        workflow_path,
        workflow_path + "@main",
        workflow_path + "@refs/heads/main",
    }


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
        raise RuntimeError("GitHub command failed; command output withheld")
    if len(completed.stdout.encode()) > MAX_GITHUB_OUTPUT_BYTES:
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

    def _artifact_name_matches(self, locator: dict, record: dict) -> bool:
        run_id = record["producer"]["runId"]
        attempt = record["producer"]["runAttempt"]
        schema = record["schema"]
        if schema == "deployment-success-v1":
            if record["producer"]["workflowPath"] == ".github/workflows/bootstrap-deployment-evidence.yml":
                expected = f"bootstrap-{record['lane']}-{run_id}-{attempt}"
            else:
                expected = f"deployment-{record['lane']}-{run_id}-{attempt}"
        elif schema == "empty-observation-v1":
            expected = f"bootstrap-{record['lane']}-{run_id}-{attempt}"
        elif schema == "backend-release-v1":
            expected = f"backend-release-{run_id}-{attempt}"
        elif schema == "consumption-v1":
            expected = f"consumption-production-{run_id}-{attempt}"
        elif schema == "retention-checkpoint-v1":
            expected = f"retention-checkpoint-{record['lane']}-{run_id}-{attempt}"
        else:
            return False
        return locator["artifactName"] == expected

    def _resolve(
        self,
        locator: dict,
        *,
        expected_schema: str,
        expected_lane: str,
        expected_digest: str | None,
        require_live: bool,
        strict_artifact_name: bool,
        skip_empty_observation: bool = False,
    ) -> dict | None:
        repository = locator["repository"]
        artifact = self._json_command([
            "gh", "api", f"repos/{repository}/actions/artifacts/{locator['artifactId']}",
        ])
        if artifact.get("id") != locator["artifactId"] or artifact.get("name") != locator["artifactName"]:
            raise ValueError("artifact metadata does not match immutable coordinates")
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
            try:
                self.runner([
                    "gh", "run", "download", str(locator["runId"]),
                    "--repo", repository,
                    "--name", locator["artifactName"],
                    "--dir", str(root),
                ], cwd=None)
            except RuntimeError:
                raise RuntimeError("GitHub evidence artifact download failed") from None
            files = [path for path in root.rglob("*") if path.is_file() or path.is_symlink()]
            if len(files) != 1 or files[0].name != "evidence.json" or files[0].is_symlink():
                raise ValueError("downloaded evidence artifact must contain exactly one regular evidence.json")
            raw = files[0].read_bytes()
            if len(raw) > MAX_RECORD_BYTES:
                raise ValueError("downloaded evidence exceeds 64 KiB")
            digest = hashlib.sha256(raw).hexdigest()
            if expected_digest is not None and digest != expected_digest:
                raise ValueError("downloaded raw JSON digest does not match locator")
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                raise ValueError("downloaded evidence contains invalid JSON") from None
            validate_record(record)
            if canonical_json(record) != raw:
                raise ValueError("downloaded evidence is not canonical JSON")
            resolved_locator = validate_locator({**locator, "sha256": digest})
            producer = record["producer"]
            if producer["workflowPath"] not in TRUSTED_WORKFLOWS.get(record["schema"], set()):
                raise ValueError("evidence producer workflow is not allowed for its schema")
            if strict_artifact_name and not self._artifact_name_matches(resolved_locator, record):
                raise ValueError("artifact name does not match the canonical evidence publication contract")
            if (
                producer["runId"] != run.get("id")
                or producer["runAttempt"] != run.get("run_attempt")
                or producer["sourceSha"] != run.get("head_sha")
                or not _run_path_matches_main(run.get("path"), producer["workflowPath"])
                or producer["event"] != run.get("event")
            ):
                raise ValueError("evidence producer does not match artifact workflow run metadata")
            try:
                self.runner([
                    "gh", "attestation", "verify", str(files[0]),
                    "--repo", repository,
                    "--signer-workflow", f"{repository}/{producer['workflowPath']}",
                    "--source-ref", "refs/heads/main",
                    "--source-digest", producer["sourceSha"],
                ], cwd=None)
            except RuntimeError:
                raise RuntimeError("GitHub attestation verification failed") from None
        if skip_empty_observation and record["schema"] == "empty-observation-v1":
            return None
        allowed_schemas = (
            DELIVERY_HEAD_SCHEMAS | {"empty-observation-v1"}
            if expected_schema == "bootstrap-evidence-v1"
            else DELIVERY_HEAD_SCHEMAS if expected_schema == "delivery-head-v1" else {expected_schema}
        )
        if record["schema"] not in allowed_schemas or record.get("lane") != expected_lane:
            raise ValueError("evidence schema or lane does not match requested context")
        if record["repository"] != repository:
            raise ValueError("evidence repository does not match immutable coordinates")
        if require_live:
            if record["schema"] not in DELIVERY_HEAD_SCHEMAS or self.live_readback is None:
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
        return {"locator": resolved_locator, "record": record}

    def resolve(self, locator, *, expected_schema: str, expected_lane: str) -> dict:
        locator = validate_locator(locator)
        resolved = self._resolve(
            locator,
            expected_schema=expected_schema,
            expected_lane=expected_lane,
            expected_digest=locator["sha256"],
            require_live=expected_schema in DELIVERY_HEAD_SCHEMAS,
            strict_artifact_name=False,
        )
        assert resolved is not None
        return resolved["record"]

    def resolve_coordinates(
        self,
        *,
        repository: str,
        run_id: int,
        artifact_id: int,
        artifact_name: str,
        expected_schema: str,
        expected_lane: str,
        require_live: bool = False,
        skip_empty_observation: bool = False,
    ) -> dict | None:
        coordinates = {
            "repository": repository,
            "runId": run_id,
            "artifactId": artifact_id,
            "artifactName": artifact_name,
            "fileName": "evidence.json",
            "sha256": "0" * 64,
        }
        locator = validate_locator(coordinates)
        return self._resolve(
            locator,
            expected_schema=expected_schema,
            expected_lane=expected_lane,
            expected_digest=None,
            require_live=require_live,
            strict_artifact_name=True,
            skip_empty_observation=skip_empty_observation,
        )


def _load_coolify_client_module():
    script_root = pathlib.Path(__file__).resolve().parent
    candidates = [script_root, script_root / "assets"]
    for candidate in candidates:
        if (candidate / "coolify_client.py").is_file():
            sys.path.insert(0, str(candidate))
            try:
                import coolify_client  # type: ignore
            finally:
                sys.path.pop(0)
            return coolify_client
    raise RuntimeError("reviewed Coolify client is not installed beside the evidence ledger")


def _verified_coolify_client():
    module = _load_coolify_client_module()
    base_url = os.environ.get("COOLIFY_URL")
    token = os.environ.get("COOLIFY_VERIFY_TOKEN")
    if not base_url or not token:
        raise ValueError("COOLIFY_URL and COOLIFY_VERIFY_TOKEN are required for live verification")
    policy = module.AccessPolicy.from_environment(
        "verify", os.environ, prefix="COOLIFY_VERIFY_TOKEN"
    )
    return module, module.CoolifyClient(base_url, token, policy)


def _application_path(client, resource_uuid: str) -> str:
    return client.literal_path("applications", _literal(resource_uuid, "resource UUID"))


def _deployment_path(client, deployment_uuid: str) -> str:
    return client.literal_path("deployments", _literal(deployment_uuid, "deployment UUID"))


def live_deployment_readback(
    record: dict,
    *,
    resource_uuid: str,
    health_url: str,
) -> dict:
    authorize_deployment_predecessor(record)
    if record["resourceUuid"] != resource_uuid:
        raise ValueError("deployment evidence resource does not match requested resource")
    health_hash = hashlib.sha256(health_url.encode()).hexdigest()
    if record["healthUrlSha256"] != health_hash:
        raise ValueError("deployment evidence health URL does not match requested endpoint")
    module, client = _verified_coolify_client()
    application = client.request("GET", _application_path(client, resource_uuid))
    if not isinstance(application, dict):
        raise RuntimeError("Coolify application readback must return an object")
    if application.get("git_commit_sha") != record["revision"]:
        raise ValueError("live application pin does not match deployment evidence")
    if application.get("is_auto_deploy_enabled") is not False:
        raise ValueError("live application auto deploy must remain disabled")
    deployed = client.request("GET", _deployment_path(client, record["deploymentUuid"]))
    if not isinstance(deployed, dict):
        raise RuntimeError("Coolify deployment readback must return an object")
    if str(deployed.get("status", "")).lower() not in SUCCESS_STATUSES:
        raise ValueError("live deployment is not in a successful terminal state")
    if deployed.get("commit") != record["revision"]:
        raise ValueError("live deployment revision does not match evidence")
    if deployed.get("resource_uuid") != resource_uuid:
        raise ValueError("live deployment resource does not match evidence")
    module.probe_https_health(health_url)
    return {
        "provider": "coolify",
        "resourceUuid": resource_uuid,
        "revision": record["revision"],
        "deploymentUuid": record["deploymentUuid"],
        "healthUrlSha256": health_hash,
        "healthVerified": True,
        "autoDeployDisabled": True,
    }


def observe_import_existing(
    *,
    resource_uuid: str,
    expected_revision: str,
    deployment_uuid: str,
    health_url: str,
) -> dict:
    _literal(resource_uuid, "resource UUID")
    _full_sha(expected_revision, "expected revision")
    _literal(deployment_uuid, "existing deployment UUID")
    module, client = _verified_coolify_client()
    application = client.request("GET", _application_path(client, resource_uuid))
    deployed = client.request("GET", _deployment_path(client, deployment_uuid))
    if not isinstance(application, dict) or not isinstance(deployed, dict):
        raise RuntimeError("Coolify import readback must return objects")
    if application.get("git_commit_sha") != expected_revision:
        raise ValueError("import live application revision does not match expected revision")
    if application.get("is_auto_deploy_enabled") is not False:
        raise ValueError("import requires source auto deploy disabled")
    if str(deployed.get("status", "")).lower() not in SUCCESS_STATUSES:
        raise ValueError("import requires a successful live deployment")
    if deployed.get("commit") != expected_revision:
        raise ValueError("import live deployment revision does not match expected revision")
    if deployed.get("resource_uuid") != resource_uuid:
        raise ValueError("import live deployment resource does not match")
    module.probe_https_health(health_url)
    return {
        "resourceUuid": resource_uuid,
        "revision": expected_revision,
        "deploymentUuid": deployment_uuid,
        "status": str(deployed.get("status", "")).lower(),
        "autoDeployDisabled": True,
        "healthVerified": True,
        "healthUrlSha256": hashlib.sha256(health_url.encode()).hexdigest(),
        "provider": "coolify",
    }


def verify_empty_observation(*, resource_uuid: str) -> None:
    _literal(resource_uuid, "resource UUID")
    _module, client = _verified_coolify_client()
    application = client.request("GET", _application_path(client, resource_uuid))
    if not isinstance(application, dict):
        raise RuntimeError("Coolify application readback must return an object")
    if application.get("is_auto_deploy_enabled") is not False:
        raise ValueError("empty observation requires source auto deploy disabled")
    deployments = client.request("GET", "/deployments")
    if isinstance(deployments, dict):
        deployments = deployments.get("data")
    if not isinstance(deployments, list) or len(deployments) > MAX_ARTIFACTS:
        raise RuntimeError("Coolify deployment inventory must be a bounded list")
    for deployed in deployments:
        if not isinstance(deployed, dict):
            raise RuntimeError("Coolify deployment inventory entries must be objects")
        if (
            deployed.get("resource_uuid") == resource_uuid
            and str(deployed.get("status", "")).lower() in SUCCESS_STATUSES
        ):
            raise ValueError("empty observation refused because a successful deployment exists")


def _artifact_pages(repository: str, runner: Callable = _default_runner) -> list[dict]:
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("repository must be owner/repository")
    try:
        raw = runner([
            "gh", "api", f"repos/{repository}/actions/artifacts?per_page=100",
            "--paginate", "--slurp",
        ], cwd=None)
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError("GitHub artifact inventory returned invalid JSON") from None
    if isinstance(value, dict):
        pages = [value]
    elif isinstance(value, list):
        pages = value
    else:
        raise RuntimeError("GitHub artifact inventory must return pages")
    artifacts: list[dict] = []
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("artifacts"), list):
            raise RuntimeError("GitHub artifact inventory page is malformed")
        artifacts.extend(page["artifacts"])
        if len(artifacts) > MAX_ARTIFACTS:
            raise RuntimeError("GitHub artifact inventory exceeds 1000 entries")
    return artifacts


def scan_authenticated_artifacts(
    *,
    repository: str,
    schema: str,
    lane: str,
    adapter: GitHubArtifactAdapter | None = None,
) -> list[tuple[dict, dict]]:
    adapter = adapter or GitHubArtifactAdapter()
    if schema == "deployment-success-v1":
        prefixes = (f"deployment-{lane}-", f"bootstrap-{lane}-")
    elif schema == "backend-release-v1":
        prefixes = ("backend-release-",)
    elif schema == "consumption-v1":
        prefixes = ("consumption-production-",)
    else:
        raise ValueError("unsupported evidence scan schema")
    entries = []
    for artifact in _artifact_pages(repository, adapter.runner):
        if not isinstance(artifact, dict):
            raise RuntimeError("GitHub artifact inventory entries must be objects")
        name = artifact.get("name")
        if not isinstance(name, str) or not name.startswith(prefixes):
            continue
        workflow_run = artifact.get("workflow_run")
        artifact_id = artifact.get("id")
        if (
            type(artifact_id) is not int
            or not isinstance(workflow_run, dict)
            or type(workflow_run.get("id")) is not int
        ):
            raise RuntimeError("GitHub evidence artifact coordinates are malformed")
        resolved = adapter.resolve_coordinates(
            repository=repository,
            run_id=workflow_run["id"],
            artifact_id=artifact_id,
            artifact_name=name,
            expected_schema=schema,
            expected_lane=lane,
            require_live=False,
            skip_empty_observation=schema == "deployment-success-v1",
        )
        if resolved is not None:
            entries.append((resolved["locator"], resolved["record"]))
    return entries


def scan_delivery_evidence(
    *,
    repository: str,
    lane: str,
    include_empty_observations: bool = False,
    adapter: GitHubArtifactAdapter | None = None,
) -> list[tuple[dict, dict]]:
    adapter = adapter or GitHubArtifactAdapter()
    prefixes = (
        f"deployment-{lane}-",
        f"bootstrap-{lane}-",
        f"retention-checkpoint-{lane}-",
    )
    entries = []
    for artifact in _artifact_pages(repository, adapter.runner):
        if not isinstance(artifact, dict):
            raise RuntimeError("GitHub artifact inventory entries must be objects")
        if artifact.get("expired") is True:
            continue
        name = artifact.get("name")
        if not isinstance(name, str) or not name.startswith(prefixes):
            continue
        workflow_run = artifact.get("workflow_run")
        artifact_id = artifact.get("id")
        if (
            type(artifact_id) is not int
            or not isinstance(workflow_run, dict)
            or type(workflow_run.get("id")) is not int
        ):
            raise RuntimeError("GitHub evidence artifact coordinates are malformed")
        run = adapter._json_command([
            "gh", "api", f"repos/{repository}/actions/runs/{workflow_run['id']}",
        ])
        if run.get("id") != workflow_run["id"]:
            raise RuntimeError("GitHub evidence workflow run coordinates are malformed")
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        resolved = adapter.resolve_coordinates(
            repository=repository,
            run_id=workflow_run["id"],
            artifact_id=artifact_id,
            artifact_name=name,
            expected_schema="bootstrap-evidence-v1" if include_empty_observations else "delivery-head-v1",
            expected_lane=lane,
            require_live=False,
            skip_empty_observation=not include_empty_observations,
        )
        if resolved is not None:
            entries.append((resolved["locator"], resolved["record"]))
    return entries


def verify_target_ci_run(*, repository: str, run_id: int, revision: str) -> None:
    run = GitHubArtifactAdapter()._json_command([
        "gh", "api", f"repos/{repository}/actions/runs/{run_id}",
    ])
    if (
        run.get("id") != run_id
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("event") != "push"
        or run.get("head_branch") != "stage"
        or run.get("head_sha") != revision
        or not _run_path_matches_main(run.get("path"), ".github/workflows/ci.yml")
    ):
        raise ValueError("target CI run is not the exact successful stage push gate")


def command_validate(args) -> None:
    record = validate_record(read_canonical_json(args.path, label="evidence"))
    _report("validate", schema=record["schema"])


def command_resolve_head(args) -> None:
    repository = args.repository
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("repository must be owner/repository")
    _literal(args.resource_uuid, "resource UUID")
    has_ci_run = args.target_ci_run_id is not None
    has_ci_revision = args.target_revision is not None
    if has_ci_run != has_ci_revision:
        raise ValueError("target CI run ID and revision must be supplied together")
    if has_ci_run:
        if args.lane != "stage":
            raise ValueError("target CI binding is allowed only for the stage lane")
        verify_target_ci_run(
            repository=repository,
            run_id=_positive_int(args.target_ci_run_id, "target CI run ID"),
            revision=_full_sha(args.target_revision, "target revision"),
        )
    entries = scan_delivery_evidence(repository=repository, lane=args.lane)
    locator, record = resolve_current_delivery_head(entries)
    authorize_deployment_predecessor(record)
    if record["repository"] != repository or record["lane"] != args.lane:
        raise ValueError("resolved deployment head does not match requested lane")
    live_deployment_readback(
        record,
        resource_uuid=args.resource_uuid,
        health_url=args.health_url,
    )
    envelope = validate_envelope({"locator": locator, "record": record})
    write_canonical_json(envelope, args.output)
    write_canonical_json(deployment_to_local_record(record), args.deploy_record_output)
    _report("resolve-stage-head", schema=record["schema"], lane=args.lane, sequence=record["sequence"])


def command_resolve_locator(args) -> None:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("GITHUB_REPOSITORY must be owner/repository")
    if args.schema in {"deployment-success-v1", "delivery-head-v1"}:
        has_live = args.resource_uuid is not None or args.health_url is not None
        if args.historical and has_live:
            raise ValueError("historical deployment resolution must not claim current live authority")
        if not args.historical and (args.resource_uuid is None or args.health_url is None):
            raise ValueError("current deployment resolution requires resource UUID and health URL")
    elif args.historical or args.resource_uuid is not None or args.health_url is not None:
        raise ValueError("historical/live flags apply only to deployment evidence")
    adapter = GitHubArtifactAdapter()
    resolved = adapter.resolve_coordinates(
        repository=repository,
        run_id=args.run_id,
        artifact_id=args.artifact_id,
        artifact_name=args.artifact_name,
        expected_schema=args.schema,
        expected_lane=args.lane,
        require_live=False,
    )
    assert resolved is not None
    record = resolved["record"]
    if args.expected_revision is not None:
        expected = _full_sha(args.expected_revision, "expected revision")
        actual = record.get("releaseRevision") if args.schema == "backend-release-v1" else record.get("revision")
        if actual != expected:
            raise ValueError("evidence revision does not match expected revision")
    if args.schema in {"deployment-success-v1", "delivery-head-v1"} and not args.historical:
        entries = scan_delivery_evidence(repository=repository, lane=args.lane)
        head_locator, _head_record = resolve_current_delivery_head(entries)
        if canonical_json(head_locator) != canonical_json(resolved["locator"]):
            raise ValueError("deployment locator is not the unique authenticated chain head")
        live_deployment_readback(
            record,
            resource_uuid=args.resource_uuid,
            health_url=args.health_url,
        )
    elif args.schema == "backend-release-v1":
        entries = scan_authenticated_artifacts(
            repository=repository,
            schema="backend-release-v1",
            lane=args.lane,
        )
        head_locator, _head_record = resolve_unique_head(entries)
        if canonical_json(head_locator) != canonical_json(resolved["locator"]):
            raise ValueError("backend locator is not the unique authenticated chain head")
    write_canonical_json(resolved, args.output)
    if args.deploy_record_output is not None:
        if args.schema not in {"deployment-success-v1", "delivery-head-v1"} or args.historical:
            raise ValueError("deploy record output requires current deployment evidence")
        write_canonical_json(deployment_to_local_record(record), args.deploy_record_output)
    _report("resolve-locator", schema=args.schema, lane=args.lane, sequence=record["sequence"])


def command_successor(args) -> None:
    envelope = load_envelope(
        args.predecessor,
        schema="delivery-head-v1",
        lane=args.lane,
    )
    previous = authorize_deployment_predecessor(envelope["record"])
    local = validate_deploy_success_record(
        read_canonical_json(args.deploy_record, label="local exact-deployment record"),
        resource_uuid=previous["resourceUuid"],
    )
    target_revision = _full_sha(args.target_revision, "target revision")
    if local["revision"] != target_revision:
        raise ValueError("local deployment revision does not match target revision")
    if local["healthUrlSha256"] != previous["healthUrlSha256"]:
        raise ValueError("local deployment health URL does not match predecessor")
    if args.lane == "stage":
        if args.target_ci_run_id is None:
            raise ValueError("stage successor requires target CI run ID")
        target = {
            "revision": target_revision,
            "ciRunId": args.target_ci_run_id,
            "ciWorkflowPath": ".github/workflows/ci.yml",
        }
    else:
        if args.target_ci_run_id is not None:
            raise ValueError("production successor must not contain a target CI run ID")
        target = {"revision": target_revision, "ciRunId": None, "ciWorkflowPath": None}
    producer = producer_from_environment({
        ".github/workflows/coolify-deploy.yml",
        ".github/workflows/coolify-rollback.yml",
    })
    candidate = validate_record({
        "schema": "deployment-success-v1",
        "repository": previous["repository"],
        "lane": args.lane,
        "provider": "coolify",
        "resourceUuid": previous["resourceUuid"],
        "revision": target_revision,
        "deploymentUuid": local["deploymentUuid"],
        "healthUrlSha256": previous["healthUrlSha256"],
        "healthVerified": True,
        "autoDeployDisabled": True,
        "sequence": previous["sequence"] + 1,
        "predecessor": envelope["locator"],
        "target": target,
        "producer": producer,
        "outcome": "deployment-succeeded",
    })
    validate_successor(previous, envelope["locator"], candidate)
    write_canonical_json(candidate, args.output)
    _report("successor", schema=candidate["schema"], lane=args.lane, sequence=candidate["sequence"])


def command_derive_rollback(args) -> None:
    locator, record = load_record_or_envelope(args.evidence)
    if record.get("schema") in DELIVERY_HEAD_SCHEMAS and locator is None:
        raise ValueError("rollback requires a verified evidence envelope")
    print(f"revision={derive_rollback_revision(record)}")


def command_backend_receipt(args) -> None:
    contracts = {
        "postgres": ("coolify.postgresql", "coolify-postgresql"),
        "convex": ("convex.deployment", "convex"),
    }
    kind, provider = contracts[args.capability]
    receipt = validate_capability_receipt({
        "capabilityId": args.capability,
        "kind": kind,
        "provider": provider,
        "resourceRef": args.resource_ref,
        "previousRevision": args.previous_revision,
        "backupRef": args.backup_ref,
        "receiptSha256": args.receipt_sha256,
        "outcome": "prepared-expand-only",
    })
    write_canonical_json(receipt, args.output)
    _report("backend-receipt", capability=args.capability)


def _previous_coordinates(args) -> tuple[int, int, str] | None:
    values = (args.previous_run_id, args.previous_artifact_id, args.previous_artifact_name)
    present = tuple(value not in (None, "") for value in values)
    if any(present) and not all(present):
        raise ValueError("previous backend locator coordinates must be all present or all empty")
    if not any(present):
        return None
    return (
        _positive_int_from_text(str(args.previous_run_id), "previous run ID"),
        _positive_int_from_text(str(args.previous_artifact_id), "previous artifact ID"),
        _literal(args.previous_artifact_name, "previous artifact name"),
    )


def command_aggregate_backend(args) -> None:
    if args.schema != "backend-release-v1":
        raise ValueError("aggregate backend schema must be backend-release-v1")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("GITHUB_REPOSITORY must be owner/repository")
    receipt_dir = _bounded_path(args.receipts, "receipt directory")
    if receipt_dir.is_symlink() or not receipt_dir.is_dir():
        raise ValueError("receipt directory must be a real directory")
    receipt_paths = sorted(receipt_dir.iterdir())
    if not receipt_paths or len(receipt_paths) > 16:
        raise ValueError("receipt directory must contain between 1 and 16 entries")
    receipts = []
    for path in receipt_paths:
        if path.is_symlink() or not path.is_file():
            raise ValueError("receipt directory must contain only regular files")
        receipts.append(validate_capability_receipt(
            read_canonical_json(path, label="backend capability receipt")
        ))
    receipts.sort(key=lambda value: value["capabilityId"])
    identifiers = [value["capabilityId"] for value in receipts]
    expected = sorted(set(args.expected_capability))
    if len(expected) != len(args.expected_capability) or identifiers != expected:
        raise ValueError("backend receipts must exactly match the expected capability set")
    previous_coordinates = _previous_coordinates(args)
    entries = scan_authenticated_artifacts(
        repository=repository,
        schema="backend-release-v1",
        lane="production",
    )
    if previous_coordinates is None:
        if entries:
            raise ValueError("backend sequence 0 is forbidden when an authenticated chain already exists")
        predecessor = None
        sequence = 0
    else:
        if not entries:
            raise ValueError("previous backend evidence was supplied but no authenticated chain exists")
        run_id, artifact_id, artifact_name = previous_coordinates
        resolved = GitHubArtifactAdapter().resolve_coordinates(
            repository=repository,
            run_id=run_id,
            artifact_id=artifact_id,
            artifact_name=artifact_name,
            expected_schema="backend-release-v1",
            expected_lane="production",
        )
        assert resolved is not None
        head_locator, head_record = resolve_unique_head(entries)
        if canonical_json(head_locator) != canonical_json(resolved["locator"]):
            raise ValueError("previous backend locator is not the unique authenticated chain head")
        predecessor = head_locator
        sequence = head_record["sequence"] + 1
    release_revision = _full_sha(args.release_revision, "release revision")
    producer = producer_from_environment({".github/workflows/backend-prepare.yml"})
    record = validate_record({
        "schema": "backend-release-v1",
        "repository": repository,
        "lane": "production",
        "provider": "aggregate",
        "releaseRevision": release_revision,
        "capabilities": receipts,
        "sequence": sequence,
        "predecessor": predecessor,
        "producer": producer,
        "outcome": "backend-release-succeeded",
    })
    write_canonical_json(record, args.output)
    _report("aggregate-backend", schema=record["schema"], sequence=sequence, capabilities=identifiers)


def command_verify_backend_capability(args) -> None:
    _locator, record = load_record_or_envelope(args.evidence)
    if record.get("schema") != "backend-release-v1":
        raise ValueError("backend capability verification requires backend-release-v1")
    revision = _full_sha(args.revision, "revision")
    if record["releaseRevision"] != revision:
        raise ValueError("backend release revision does not match application revision")
    matches = [entry for entry in record["capabilities"] if entry["capabilityId"] == args.capability]
    if len(matches) != 1:
        raise ValueError("backend release does not contain the required capability")
    validate_capability_receipt(matches[0])
    _report("verify-backend-capability", capability=args.capability, revision=revision)


def command_consume(args) -> None:
    deployment_envelope = load_envelope(
        args.deployment,
        schema="deployment-success-v1",
        lane="production",
    )
    backend_envelope = load_envelope(
        args.backend,
        schema="backend-release-v1",
        lane="production",
    )
    deployment_record = authorize_deployment_predecessor(deployment_envelope["record"])
    backend_record = backend_envelope["record"]
    revision = _full_sha(args.application_revision, "application revision")
    resource_uuid = _literal(args.resource_uuid, "resource UUID")
    if deployment_record["resourceUuid"] != resource_uuid:
        raise ValueError("deployment evidence resource does not match application resource")
    if deployment_record["revision"] != revision:
        raise ValueError("deployment evidence revision does not match application revision")
    if backend_record["releaseRevision"] != revision:
        raise ValueError("backend release revision does not match application revision")
    if backend_record["repository"] != deployment_record["repository"]:
        raise ValueError("backend and deployment evidence repositories do not match")
    entries = scan_authenticated_artifacts(
        repository=deployment_record["repository"],
        schema="consumption-v1",
        lane="production",
    )
    prior = [record for _locator, record in entries]
    if entries:
        predecessor, head = resolve_unique_head(entries)
        sequence = head["sequence"] + 1
    else:
        predecessor = None
        sequence = 0
    producer = producer_from_environment({".github/workflows/coolify-deploy.yml"})
    candidate = build_consumption_record(
        repository=deployment_record["repository"],
        application_revision=revision,
        resource_uuid=resource_uuid,
        deployment_evidence=deployment_envelope["locator"],
        backend_evidence=backend_envelope["locator"],
        producer=producer,
        sequence=sequence,
        predecessor=predecessor,
    )
    validate_consumption(candidate, prior, backend_record)
    write_canonical_json(candidate, args.output)
    _report("consume", schema=candidate["schema"], sequence=sequence)


def assert_bootstrap_available(
    *,
    repository: str,
    lane: str,
    resource_uuid: str,
    health_url: str,
    mode: str,
) -> bool:
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("repository must be owner/repository")
    if lane not in LANES or mode not in {"import-existing", "initialize-empty"}:
        raise ValueError("bootstrap mode or lane is invalid")
    _literal(resource_uuid, "resource UUID")
    health_hash = hashlib.sha256(health_url.encode()).hexdigest()
    entries = scan_delivery_evidence(
        repository=repository,
        lane=lane,
        include_empty_observations=True,
    )
    relevant = [
        entry for entry in entries
        if entry[1]["resourceUuid"] == resource_uuid and entry[1]["healthUrlSha256"] == health_hash
    ]
    delivery_entries = [entry for entry in relevant if entry[1]["schema"] in DELIVERY_HEAD_SCHEMAS]
    if delivery_entries:
        resolve_current_delivery_head(delivery_entries)
        raise ValueError("bootstrap refused because an existing deployment chain is already authenticated")
    empty_present = any(entry[1]["schema"] == "empty-observation-v1" for entry in relevant)
    if empty_present and mode == "initialize-empty":
        raise ValueError("bootstrap refused because an empty observation already exists")
    return empty_present


def command_assert_bootstrap_available(args) -> None:
    empty_present = assert_bootstrap_available(
        repository=args.repository,
        lane=args.lane,
        resource_uuid=args.resource_uuid,
        health_url=args.health_url,
        mode=args.mode,
    )
    _report(
        "assert-bootstrap-available",
        lane=args.lane,
        chainAbsent=True,
        emptyObservationPresent=empty_present,
    )


def command_published_locator(args) -> None:
    record = validate_record(read_canonical_json(args.evidence, label="successor evidence"))
    if record["schema"] != "deployment-success-v1":
        raise ValueError("published locator requires deployment-success-v1 successor evidence")
    producer = producer_from_environment({
        ".github/workflows/coolify-deploy.yml",
        ".github/workflows/coolify-rollback.yml",
    })
    if record["producer"] != producer:
        raise ValueError("published successor evidence producer does not match the current workflow run")
    locator = validate_locator({
        "repository": record["repository"],
        "runId": producer["runId"],
        "artifactId": _positive_int(args.artifact_id, "artifact ID"),
        "artifactName": args.artifact_name,
        "fileName": "evidence.json",
        "sha256": hashlib.sha256(canonical_json(record)).hexdigest(),
    })
    if not GitHubArtifactAdapter()._artifact_name_matches(locator, record):
        raise ValueError("published successor artifact name does not match the canonical contract")
    envelope = validate_envelope({"locator": locator, "record": record})
    write_canonical_json(envelope, args.output)
    _report("published-locator", lane=record["lane"], sequence=record["sequence"])


def command_create_retention_checkpoint(args) -> None:
    repository = args.repository
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("repository must be owner/repository")
    _literal(args.resource_uuid, "resource UUID")
    entries = scan_delivery_evidence(repository=repository, lane=args.lane)
    head_locator, head_record = resolve_current_delivery_head(entries)
    if head_record["repository"] != repository or head_record["resourceUuid"] != args.resource_uuid:
        raise ValueError("current delivery head does not match the requested checkpoint resource")
    live_deployment_readback(head_record, resource_uuid=args.resource_uuid, health_url=args.health_url)
    producer = producer_from_environment({".github/workflows/evidence-retention-checkpoint.yml"})
    checkpoint = build_retention_checkpoint(
        head_locator,
        head_record,
        producer=producer,
        epoch=delivery_head_epoch(entries, head_locator) + 1,
    )
    write_canonical_json(checkpoint, args.output)
    _report(
        "create-retention-checkpoint",
        lane=args.lane,
        epoch=checkpoint["epoch"],
        expiresAt=checkpoint["expiresAt"],
    )


def command_bootstrap_import(args) -> None:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    lane = os.environ.get("LANE", "")
    resource_uuid = os.environ.get("RESOURCE_UUID", "")
    health_url = os.environ.get("HEALTH_URL", "")
    expected_revision = os.environ.get("EXPECTED_REVISION", "")
    deployment_uuid = os.environ.get("EXISTING_DEPLOYMENT_UUID", "")
    assert_bootstrap_available(
        repository=repository,
        lane=lane,
        resource_uuid=resource_uuid,
        health_url=health_url,
        mode="import-existing",
    )
    observation = observe_import_existing(
        resource_uuid=resource_uuid,
        expected_revision=expected_revision,
        deployment_uuid=deployment_uuid,
        health_url=health_url,
    )
    producer = producer_from_environment({".github/workflows/bootstrap-deployment-evidence.yml"})
    record = bootstrap_import_existing(
        observation,
        repository=repository,
        lane=lane,
        resource_uuid=resource_uuid,
        expected_revision=expected_revision,
        health_url=health_url,
        producer=producer,
    )
    write_canonical_json(record, args.output)
    _report("bootstrap-import-existing", schema=record["schema"], lane=lane, sequence=0)


def command_bootstrap_empty(args) -> None:
    if args.schema != "empty-observation-v1":
        raise ValueError("bootstrap empty schema must be empty-observation-v1")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    lane = os.environ.get("LANE", "")
    resource_uuid = os.environ.get("RESOURCE_UUID", "")
    health_url = os.environ.get("HEALTH_URL", "")
    assert_bootstrap_available(
        repository=repository,
        lane=lane,
        resource_uuid=resource_uuid,
        health_url=health_url,
        mode="initialize-empty",
    )
    verify_empty_observation(resource_uuid=resource_uuid)
    producer = producer_from_environment({".github/workflows/bootstrap-deployment-evidence.yml"})
    record = bootstrap_empty_observation(
        repository=repository,
        lane=lane,
        provider="coolify",
        resource_uuid=resource_uuid,
        health_url=health_url,
        producer=producer,
    )
    write_canonical_json(record, args.output)
    _report("bootstrap-empty", schema=record["schema"], lane=lane, sequence=0)


def command_compensate(args) -> None:
    envelope = load_envelope(args.predecessor, schema="delivery-head-v1")
    predecessor = authorize_deployment_predecessor(envelope["record"])
    current = validate_deploy_success_record(
        read_canonical_json(args.deploy_record, label="local exact-deployment record"),
        resource_uuid=predecessor["resourceUuid"],
        health_url=args.health_url,
    )
    if predecessor["healthUrlSha256"] != current["healthUrlSha256"]:
        raise ValueError("compensation predecessor health URL does not match current deployment")
    helper = pathlib.Path(__file__).resolve().with_name("deploy_exact_revision.py")
    if not helper.is_file() or helper.is_symlink():
        raise RuntimeError("reviewed exact-deployment helper is not installed beside evidence ledger")
    environment_names = {
        "PATH", "HOME",
        "COOLIFY_URL",
        "COOLIFY_PIN_TOKEN", "COOLIFY_PIN_TOKEN_SCOPES",
        "COOLIFY_PIN_TOKEN_EXPIRES_AT", "COOLIFY_PIN_TOKEN_IP_ALLOWLISTED",
        "COOLIFY_DEPLOY_TOKEN", "COOLIFY_DEPLOY_TOKEN_SCOPES",
        "COOLIFY_DEPLOY_TOKEN_EXPIRES_AT", "COOLIFY_DEPLOY_TOKEN_IP_ALLOWLISTED",
    }
    lock_dir = _bounded_path(args.lock_dir, "lock directory")
    completed = subprocess.run(
        [
            sys.executable, str(helper),
            "--resource-uuid", predecessor["resourceUuid"],
            "--revision", predecessor["revision"],
            "--health-url", args.health_url,
            "--lock-dir", str(lock_dir),
            "--rollback-evidence", args.deploy_record,
            "--record-output", args.deploy_record,
        ],
        env={key: value for key, value in os.environ.items() if key in environment_names},
        text=True,
        capture_output=True,
        timeout=1800,
    )
    if completed.returncode:
        raise RuntimeError("exact-deployment compensation failed; helper output withheld")
    restored = validate_deploy_success_record(
        read_canonical_json(args.deploy_record, label="compensation deployment record"),
        resource_uuid=predecessor["resourceUuid"],
        health_url=args.health_url,
    )
    if restored["revision"] != predecessor["revision"]:
        raise RuntimeError("compensation helper did not restore the verified predecessor revision")
    _report("compensate", restored=True, lane=predecessor["lane"])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Authenticated append-only deployment and backend evidence ledger",
        allow_abbrev=False,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", allow_abbrev=False)
    validate_parser.add_argument("path")
    validate_parser.set_defaults(handler=command_validate)

    head = subparsers.add_parser("resolve-stage-head", allow_abbrev=False)
    head.add_argument("--repository", required=True)
    head.add_argument("--lane", choices=sorted(LANES), required=True)
    head.add_argument("--resource-uuid", required=True)
    head.add_argument("--health-url", required=True)
    head.add_argument("--target-ci-run-id", type=int)
    head.add_argument("--target-revision")
    head.add_argument("--output", required=True)
    head.add_argument("--deploy-record-output", required=True)
    head.set_defaults(handler=command_resolve_head)

    resolve = subparsers.add_parser("resolve-locator", allow_abbrev=False)
    resolve.add_argument(
        "--schema",
        choices=[
            "deployment-success-v1", "delivery-head-v1", "backend-release-v1",
            "consumption-v1",
        ],
        required=True,
    )
    resolve.add_argument("--lane", choices=sorted(LANES), required=True)
    resolve.add_argument("--run-id", type=int, required=True)
    resolve.add_argument("--artifact-id", type=int, required=True)
    resolve.add_argument("--artifact-name", required=True)
    resolve.add_argument("--expected-revision")
    resolve.add_argument("--resource-uuid")
    resolve.add_argument("--health-url")
    resolve.add_argument("--historical", action="store_true")
    resolve.add_argument("--output", required=True)
    resolve.add_argument("--deploy-record-output")
    resolve.set_defaults(handler=command_resolve_locator)

    successor = subparsers.add_parser("successor", allow_abbrev=False)
    successor.add_argument("--lane", choices=sorted(LANES), required=True)
    successor.add_argument("--predecessor", required=True)
    successor.add_argument("--deploy-record", required=True)
    successor.add_argument("--target-ci-run-id", type=int)
    successor.add_argument("--target-revision", required=True)
    successor.add_argument("--output", required=True)
    successor.set_defaults(handler=command_successor)

    consume = subparsers.add_parser("consume", allow_abbrev=False)
    consume.add_argument("--deployment", required=True)
    consume.add_argument("--backend", required=True)
    consume.add_argument("--application-revision", required=True)
    consume.add_argument("--resource-uuid", required=True)
    consume.add_argument("--output", required=True)
    consume.set_defaults(handler=command_consume)

    rollback = subparsers.add_parser("derive-rollback", allow_abbrev=False)
    rollback.add_argument("--evidence", required=True)
    rollback.set_defaults(handler=command_derive_rollback)

    compensate = subparsers.add_parser("compensate", allow_abbrev=False)
    compensate.add_argument("--predecessor", required=True)
    compensate.add_argument("--deploy-record", required=True)
    compensate.add_argument("--health-url", required=True)
    compensate.add_argument("--lock-dir", default=".harness/locks")
    compensate.set_defaults(handler=command_compensate)

    bootstrap_import = subparsers.add_parser("bootstrap-import-existing", allow_abbrev=False)
    bootstrap_import.add_argument("--output", required=True)
    bootstrap_import.set_defaults(handler=command_bootstrap_import)

    bootstrap_empty = subparsers.add_parser("bootstrap-empty", allow_abbrev=False)
    bootstrap_empty.add_argument("--schema", required=True)
    bootstrap_empty.add_argument("--output", required=True)
    bootstrap_empty.set_defaults(handler=command_bootstrap_empty)

    bootstrap_gate = subparsers.add_parser("assert-bootstrap-available", allow_abbrev=False)
    bootstrap_gate.add_argument("--repository", required=True)
    bootstrap_gate.add_argument("--lane", choices=sorted(LANES), required=True)
    bootstrap_gate.add_argument("--resource-uuid", required=True)
    bootstrap_gate.add_argument("--health-url", required=True)
    bootstrap_gate.add_argument("--mode", choices=["import-existing", "initialize-empty"], required=True)
    bootstrap_gate.set_defaults(handler=command_assert_bootstrap_available)

    published = subparsers.add_parser("published-locator", allow_abbrev=False)
    published.add_argument("--evidence", required=True)
    published.add_argument("--artifact-id", type=int, required=True)
    published.add_argument("--artifact-name", required=True)
    published.add_argument("--output", required=True)
    published.set_defaults(handler=command_published_locator)

    checkpoint = subparsers.add_parser("create-retention-checkpoint", allow_abbrev=False)
    checkpoint.add_argument("--repository", required=True)
    checkpoint.add_argument("--lane", choices=sorted(LANES), required=True)
    checkpoint.add_argument("--resource-uuid", required=True)
    checkpoint.add_argument("--health-url", required=True)
    checkpoint.add_argument("--output", required=True)
    checkpoint.set_defaults(handler=command_create_retention_checkpoint)

    receipt = subparsers.add_parser("backend-receipt", allow_abbrev=False)
    receipt.add_argument("--capability", choices=["postgres", "convex"], required=True)
    receipt.add_argument("--resource-ref", required=True)
    receipt.add_argument("--previous-revision", required=True)
    receipt.add_argument("--backup-ref", required=True)
    receipt.add_argument("--receipt-sha256", required=True)
    receipt.add_argument("--output", required=True)
    receipt.set_defaults(handler=command_backend_receipt)

    aggregate = subparsers.add_parser("aggregate-backend", allow_abbrev=False)
    aggregate.add_argument("--receipts", required=True)
    aggregate.add_argument("--release-revision", required=True)
    aggregate.add_argument("--previous-run-id", default="")
    aggregate.add_argument("--previous-artifact-id", default="")
    aggregate.add_argument("--previous-artifact-name", default="")
    aggregate.add_argument(
        "--expected-capability",
        choices=["postgres", "convex"],
        action="append",
        required=True,
    )
    aggregate.add_argument("--schema", required=True)
    aggregate.add_argument("--output", required=True)
    aggregate.set_defaults(handler=command_aggregate_backend)

    verify_backend = subparsers.add_parser("verify-backend-capability", allow_abbrev=False)
    verify_backend.add_argument("--evidence", required=True)
    verify_backend.add_argument("--capability", choices=["postgres", "convex"], required=True)
    verify_backend.add_argument("--revision", required=True)
    verify_backend.set_defaults(handler=command_verify_backend_capability)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.handler(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=os.sys.stderr)
        raise SystemExit(2)
