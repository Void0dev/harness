"""Typed, fail-closed runtime contracts for short-lived operator evidence."""

from __future__ import annotations

import datetime
import uuid
from dataclasses import dataclass, field
from typing import TypedDict


class EvidenceMetadata(TypedDict):
    inventoryVersion: int
    inventoryId: str
    source: str
    observedAt: str
    expiresAt: str


class ApplicationEvidence(TypedDict):
    applicationUuid: str
    projectUuid: str
    serverUuid: str
    environmentName: str
    name: str
    repository: str
    branch: str
    domain: str


class DatabaseEvidence(TypedDict):
    databaseUuid: str
    databaseType: str
    projectUuid: str
    serverUuid: str
    environmentName: str
    ready: bool
    readinessSource: str


class ConvexDeploymentEvidence(TypedDict):
    capabilityId: str
    lane: str
    projectRef: str
    deploymentRef: str
    deploymentType: str
    deployKeyRef: str
    deployKeyScope: str
    ready: bool
    readinessSource: str


class DeliveryEnvironmentEvidence(TypedDict):
    lane: str
    environmentName: str
    branch: str
    credentialScope: str
    requiredReviewers: int
    preventSelfReview: bool


class EnvironmentVariableEvidence(TypedDict):
    applicationUuid: str
    key: str
    valueSha256: str


class CoolifyInventoryEvidence(EvidenceMetadata, total=False):
    applications: list[ApplicationEvidence]
    databases: list[DatabaseEvidence]
    convexDeployments: list[ConvexDeploymentEvidence]
    deliveryEnvironments: list[DeliveryEnvironmentEvidence]
    environmentVariables: list[EnvironmentVariableEvidence]


@dataclass(frozen=True)
class EvidenceContract:
    name: str
    fields: frozenset[str]
    sources: frozenset[str]
    exact_fields: bool = False
    scalar_only: bool = False
    field_types: dict[str, type] = field(default_factory=dict)
    maximum_age: datetime.timedelta = datetime.timedelta(minutes=10)
    maximum_window: datetime.timedelta = datetime.timedelta(minutes=10)
    future_skew: datetime.timedelta = datetime.timedelta(minutes=2)

    def validate(
        self,
        payload: object,
        *,
        now: datetime.datetime | None = None,
    ) -> list[str]:
        if not isinstance(payload, dict):
            return [f"{self.name} must be a JSON object"]
        errors: list[str] = []
        actual_fields = set(payload)
        missing = sorted(self.fields - actual_fields)
        extra = sorted(actual_fields - self.fields) if self.exact_fields else []
        if extra:
            errors.append(f"{self.name} contains unsupported fields")
        if missing:
            errors.append(f"{self.name} is missing fields: {', '.join(missing)}")
        if self.scalar_only and any(isinstance(value, (dict, list)) for value in payload.values()):
            errors.append(f"{self.name} fields must be scalar values")
        for field_name, expected_type in self.field_types.items():
            if field_name not in payload:
                continue
            value = payload[field_name]
            valid = isinstance(value, expected_type)
            if expected_type is int and isinstance(value, bool):
                valid = False
            if not valid:
                type_name = "boolean" if expected_type is bool else expected_type.__name__
                errors.append(f"{self.name}.{field_name} must be {type_name}")
        inventory_version = payload.get("inventoryVersion")
        if type(inventory_version) is not int or inventory_version != 1:
            errors.append(f"{self.name}Version must be 1")
        inventory_id = payload.get("inventoryId")
        try:
            if not isinstance(inventory_id, str) or str(uuid.UUID(inventory_id)) != inventory_id.lower():
                raise ValueError
        except ValueError:
            errors.append(f"{self.name}Id must be a canonical UUID")
        if payload.get("source") not in self.sources:
            errors.append(
                f"{self.name} source must be one of: {', '.join(sorted(self.sources))}"
            )
        errors.extend(self._validate_freshness(payload, now=now))
        return errors

    def _validate_freshness(
        self,
        payload: dict,
        *,
        now: datetime.datetime | None,
    ) -> list[str]:
        observed_at = payload.get("observedAt")
        expires_at = payload.get("expiresAt")
        invalid_timestamps = (
            f"{self.name} observedAt and expiresAt must be ISO-8601 timestamps with timezone"
        )
        if not isinstance(observed_at, str) or not isinstance(expires_at, str):
            return [invalid_timestamps]
        try:
            observed = datetime.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
            expires = datetime.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if observed.tzinfo is None or expires.tzinfo is None:
                raise ValueError
        except ValueError:
            return [invalid_timestamps]
        current = now or datetime.datetime.now(datetime.timezone.utc)
        if current.tzinfo is None:
            raise ValueError("evidence validation clock must include a timezone")
        now_utc = current.astimezone(datetime.timezone.utc)
        observed_utc = observed.astimezone(datetime.timezone.utc)
        expires_utc = expires.astimezone(datetime.timezone.utc)
        age = now_utc - observed_utc
        errors = []
        if age > self.maximum_age or age < -self.future_skew:
            errors.append(f"{self.name} observedAt must be a fresh timestamp from the last 10 minutes")
        if expires_utc <= now_utc:
            errors.append(f"{self.name} freshness proof is expired")
        if expires_utc <= observed_utc or expires_utc - observed_utc > self.maximum_window:
            errors.append(
                f"{self.name} expiry must be after observation and no more than 10 minutes later"
            )
        return errors


@dataclass(frozen=True)
class EvidenceSectionContract:
    name: str
    field_types: dict[str, type]

    def validate(self, payload: object) -> list[str]:
        if not isinstance(payload, list):
            return [f"{self.name} must be a list of typed evidence records"]
        errors = []
        expected = set(self.field_types)
        for index, record in enumerate(payload):
            label = f"{self.name}[{index}]"
            if not isinstance(record, dict):
                errors.append(f"{label} must be an object")
                continue
            actual = set(record)
            missing = sorted(expected - actual)
            extra = sorted(actual - expected)
            if extra:
                errors.append(f"{label} contains unsupported fields")
            if missing:
                errors.append(f"{label} is missing fields: {', '.join(missing)}")
            for field, expected_type in self.field_types.items():
                if field not in record:
                    continue
                value = record[field]
                valid = isinstance(value, expected_type)
                if expected_type is int and isinstance(value, bool):
                    valid = False
                if not valid:
                    type_name = "boolean" if expected_type is bool else expected_type.__name__
                    errors.append(f"{label}.{field} must be {type_name}")
        return errors

EVIDENCE_METADATA_FIELDS = frozenset({
    "inventoryVersion",
    "inventoryId",
    "source",
    "observedAt",
    "expiresAt",
})
COOLIFY_INVENTORY_CONTRACT = EvidenceContract(
    name="inventory",
    fields=EVIDENCE_METADATA_FIELDS,
    sources=frozenset({"coolify-api", "coolify-ui"}),
    field_types={
        "inventoryVersion": int,
        "inventoryId": str,
        "source": str,
        "observedAt": str,
        "expiresAt": str,
    },
)
COOLIFY_EVIDENCE_SECTIONS = {
    "applications": EvidenceSectionContract("applications", {
        "applicationUuid": str,
        "projectUuid": str,
        "serverUuid": str,
        "environmentName": str,
        "name": str,
        "repository": str,
        "branch": str,
        "domain": str,
    }),
    "databases": EvidenceSectionContract("databases", {
        "databaseUuid": str,
        "databaseType": str,
        "projectUuid": str,
        "serverUuid": str,
        "environmentName": str,
        "ready": bool,
        "readinessSource": str,
    }),
    "convexDeployments": EvidenceSectionContract("convexDeployments", {
        "capabilityId": str,
        "lane": str,
        "projectRef": str,
        "deploymentRef": str,
        "deploymentType": str,
        "deployKeyRef": str,
        "deployKeyScope": str,
        "ready": bool,
        "readinessSource": str,
    }),
    "deliveryEnvironments": EvidenceSectionContract("deliveryEnvironments", {
        "lane": str,
        "environmentName": str,
        "branch": str,
        "credentialScope": str,
        "requiredReviewers": int,
        "preventSelfReview": bool,
    }),
    "environmentVariables": EvidenceSectionContract("environmentVariables", {
        "applicationUuid": str,
        "key": str,
        "valueSha256": str,
    }),
}


def validate_coolify_inventory(payload: object) -> list[str]:
    errors = COOLIFY_INVENTORY_CONTRACT.validate(payload)
    if not isinstance(payload, dict):
        return errors
    allowed = EVIDENCE_METADATA_FIELDS | frozenset(COOLIFY_EVIDENCE_SECTIONS)
    if set(payload) - allowed:
        errors.append("inventory contains unsupported sections")
    for section, contract in COOLIFY_EVIDENCE_SECTIONS.items():
        if section in payload:
            errors.extend(contract.validate(payload[section]))
    return errors
