#!/usr/bin/env python3
"""Generate exact short-lived rollout evidence; provenance remains a signed bundle."""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import sys
import uuid


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from agent_evidence_contract import AGENT_INVENTORY_CONTRACT  # noqa: E402


METADATA_FIELDS = {"inventoryVersion", "inventoryId", "observedAt", "expiresAt"}
VALUE_FIELDS = set(AGENT_INVENTORY_CONTRACT.fields) - METADATA_FIELDS


def contains_null(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, dict):
        return any(contains_null(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_null(item) for item in value)
    return False


def generate(values: object) -> dict:
    if not isinstance(values, dict) or set(values) != VALUE_FIELDS:
        raise ValueError(
            "agent rollout values must define exactly: " + ", ".join(sorted(VALUE_FIELDS))
        )
    if contains_null(values):
        raise ValueError("replace every null template value with fresh non-secret evidence")
    observed = datetime.datetime.now(datetime.timezone.utc)
    payload = {
        "inventoryVersion": 1,
        "inventoryId": str(uuid.uuid4()),
        **values,
        "observedAt": observed.isoformat(),
        "expiresAt": (observed + datetime.timedelta(minutes=10)).isoformat(),
    }
    errors = AGENT_INVENTORY_CONTRACT.validate(payload)
    if errors:
        raise ValueError("; ".join(errors))
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--values-json", required=True)
    args = parser.parse_args()
    values_path = pathlib.Path(args.values_json)
    if values_path.is_symlink() or not values_path.is_file():
        raise ValueError("--values-json must be a regular non-symlink file")
    print(json.dumps(generate(json.loads(values_path.read_text())), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
