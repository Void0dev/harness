#!/usr/bin/env python3
"""Generate a short-lived, exact inventory envelope from redacted operator values."""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import sys
import uuid


SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(SKILL_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_DIR))
from harness_evidence import validate_coolify_inventory  # noqa: E402


BASE_SECTIONS = {"source", "applications", "deliveryEnvironments", "environmentVariables"}
PROFILE_SECTIONS = {
    "application": BASE_SECTIONS,
    "nest-postgres": BASE_SECTIONS | {"databases"},
    "convex": BASE_SECTIONS | {"convexDeployments"},
    "hybrid": BASE_SECTIONS | {"databases", "convexDeployments"},
}
METADATA_FIELDS = {"inventoryVersion", "inventoryId", "observedAt", "expiresAt"}


def contains_null(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, dict):
        return any(contains_null(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_null(item) for item in value)
    return False


def generate(profile: str, values: object) -> dict:
    if not isinstance(values, dict):
        raise ValueError("values JSON must be an object")
    if set(values) & METADATA_FIELDS:
        raise ValueError("values JSON must not supply generated inventory metadata")
    expected = PROFILE_SECTIONS[profile]
    if set(values) != expected:
        raise ValueError(
            f"{profile} values must define exactly: {', '.join(sorted(expected))}"
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
    errors = validate_coolify_inventory(payload)
    if errors:
        raise ValueError("; ".join(errors))
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=tuple(PROFILE_SECTIONS), required=True)
    parser.add_argument("--values-json", required=True)
    args = parser.parse_args()
    values_path = pathlib.Path(args.values_json)
    if values_path.is_symlink() or not values_path.is_file():
        raise ValueError("--values-json must be a regular non-symlink file")
    payload = generate(args.profile, json.loads(values_path.read_text()))
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
