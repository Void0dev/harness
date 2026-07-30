"""Standalone typed evidence contract for the deploy-agent verifier."""

from __future__ import annotations

import datetime
import uuid
from dataclasses import dataclass


EVIDENCE_METADATA_FIELDS = frozenset({
    "inventoryVersion",
    "inventoryId",
    "source",
    "observedAt",
    "expiresAt",
})
AGENT_INVENTORY_FIELDS = EVIDENCE_METADATA_FIELDS | frozenset({
    "applicationUuid",
    "serverUuid",
    "harnessImage",
    "opencodeWebImage",
    "dataDir",
    "replicas",
    "rolloutHarnessImage",
    "rolloutOpenCodeWebImage",
    "rolloutStatus",
})


@dataclass(frozen=True)
class AgentEvidenceContract:
    fields: frozenset[str] = AGENT_INVENTORY_FIELDS

    def validate(self, payload: object) -> list[str]:
        if not isinstance(payload, dict):
            return ["Coolify inventory must be a JSON object"]
        errors = []
        actual = set(payload)
        if actual - self.fields:
            errors.append("Coolify inventory contains unsupported fields")
        missing = sorted(self.fields - actual)
        if missing:
            errors.append("Coolify inventory is missing fields: " + ", ".join(missing))
        if any(isinstance(value, (dict, list)) for value in payload.values()):
            errors.append("Coolify inventory fields must be scalar values")
        string_fields = self.fields - {
            "inventoryVersion",
            "replicas",
        }
        for field_name in string_fields:
            if field_name in payload and not isinstance(payload[field_name], str):
                errors.append(f"Coolify inventory.{field_name} must be str")
        for field_name in ("inventoryVersion", "replicas"):
            value = payload.get(field_name)
            if type(value) is not int:
                errors.append(f"Coolify inventory.{field_name} must be int")
        if type(payload.get("inventoryVersion")) is not int or payload.get("inventoryVersion") != 1:
            errors.append("Coolify inventoryVersion must be 1")
        inventory_id = payload.get("inventoryId")
        try:
            if not isinstance(inventory_id, str) or str(uuid.UUID(inventory_id)) != inventory_id.lower():
                raise ValueError
        except ValueError:
            errors.append("Coolify inventoryId must be a canonical UUID")
        if payload.get("source") not in {"coolify-api", "coolify-ui"}:
            errors.append(
                "Coolify inventory source must be one of: coolify-api, coolify-ui"
            )
        errors.extend(_validate_freshness(payload))
        return errors


def _validate_freshness(payload: dict) -> list[str]:
    observed_at = payload.get("observedAt")
    expires_at = payload.get("expiresAt")
    invalid = (
        "Coolify inventory observedAt and expiresAt must be ISO-8601 timestamps with timezone"
    )
    if not isinstance(observed_at, str) or not isinstance(expires_at, str):
        return [invalid]
    try:
        observed = datetime.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        expires = datetime.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if observed.tzinfo is None or expires.tzinfo is None:
            raise ValueError
    except ValueError:
        return [invalid]
    now = datetime.datetime.now(datetime.timezone.utc)
    observed_utc = observed.astimezone(datetime.timezone.utc)
    expires_utc = expires.astimezone(datetime.timezone.utc)
    age = now - observed_utc
    errors = []
    if age > datetime.timedelta(minutes=10) or age < datetime.timedelta(minutes=-2):
        errors.append(
            "Coolify inventory observedAt must be a fresh timestamp from the last 10 minutes"
        )
    if expires_utc <= now:
        errors.append("Coolify inventory freshness proof is expired")
    if expires_utc <= observed_utc or expires_utc - observed_utc > datetime.timedelta(minutes=10):
        errors.append(
            "Coolify inventory expiry must be after observation and no more than 10 minutes later"
        )
    return errors


AGENT_INVENTORY_CONTRACT = AgentEvidenceContract()
