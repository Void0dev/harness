#!/usr/bin/env python3
import argparse
import datetime
import json
import pathlib
import re
import sys
import urllib.request


INVENTORY_FIELDS = {
    "applicationUuid",
    "serverUuid",
    "harnessImage",
    "sandboxImage",
    "dataDir",
    "replicas",
    "observedAt",
    "source",
}
INVENTORY_SOURCES = {"coolify-api", "coolify-ui"}


def verify_inventory(inventory: object, expected: dict) -> list[str]:
    if not isinstance(inventory, dict):
        return ["Coolify inventory must be a JSON object"]
    errors = []
    extra = sorted(set(inventory) - INVENTORY_FIELDS)
    missing = sorted(INVENTORY_FIELDS - set(inventory))
    if extra:
        errors.append("Coolify inventory contains unsupported fields")
    if missing:
        errors.append("Coolify inventory is missing fields: " + ", ".join(missing))
    if any(isinstance(value, (dict, list)) for value in inventory.values()):
        errors.append("Coolify inventory fields must be scalar values")
    mismatches = [key for key, value in expected.items() if inventory.get(key) != value]
    if mismatches:
        errors.append("Coolify inventory mismatch: " + ", ".join(mismatches))
    if inventory.get("source") not in INVENTORY_SOURCES:
        errors.append("Coolify inventory source must be coolify-api or coolify-ui")
    observed_at = inventory.get("observedAt")
    if isinstance(observed_at, str):
        try:
            observed = datetime.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
            if observed.tzinfo is None:
                raise ValueError("timezone is required")
            now = datetime.datetime.now(datetime.timezone.utc)
            age = now - observed.astimezone(datetime.timezone.utc)
            if age > datetime.timedelta(minutes=10) or age < datetime.timedelta(minutes=-2):
                errors.append("Coolify inventory observedAt must be a fresh timestamp from the last 10 minutes")
        except ValueError:
            errors.append("Coolify inventory observedAt must be an ISO-8601 timestamp with timezone")
    elif "observedAt" in inventory:
        errors.append("Coolify inventory observedAt must be an ISO-8601 timestamp with timezone")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    health_mode = parser.add_mutually_exclusive_group(required=True)
    health_mode.add_argument("--health-url")
    health_mode.add_argument("--offline", action="store_true", help="validate configuration without claiming online health")
    parser.add_argument("--inventory-json", help="fresh non-secret Coolify deployment inventory for online verification")
    args = parser.parse_args()
    root = pathlib.Path(args.repo).resolve()
    config = json.loads((root / ".harness" / "config.json").read_text())
    issue = config.get("issueAgent", {})
    errors = []
    if issue.get("baseBranch") != "stage":
        errors.append("issueAgent.baseBranch must be 'stage'")
    if not issue.get("applicationUuid"):
        errors.append("issueAgent.applicationUuid is unbound")
    digest = re.compile(r"@sha256:[0-9a-f]{64}$", re.IGNORECASE)
    for key in ("harnessImage", "sandboxImage"):
        image = issue.get(key, "")
        if not image or not digest.search(image):
            errors.append(f"issueAgent.{key} must use a 64-hex sha256 digest")
    if not (root / ".sandcastle" / "prompt.md").is_file():
        errors.append("missing .sandcastle/prompt.md")
    if not (root / ".github" / "ISSUE_TEMPLATE" / "agent-task.yml").is_file():
        errors.append("missing .github/ISSUE_TEMPLATE/agent-task.yml")
    if issue.get("dedicatedAutomationHost") is not True:
        errors.append("issueAgent.dedicatedAutomationHost must be true for raw Docker socket mode")
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

    health_verified = False
    if args.health_url:
        with urllib.request.urlopen(args.health_url, timeout=15) as response:
            health = json.loads(response.read())
        expected = config.get("project", {}).get("github")
        expected_origin = f"https://github.com/{expected}.git"
        if (
            health.get("status") != "ok"
            or health.get("repository") != expected
            or health.get("workspaceOrigin") != expected_origin
        ):
            errors.append("health response does not match the target repository")
        else:
            health_verified = True
    print(json.dumps({"verified": not errors, "healthVerified": health_verified, "inventoryVerified": inventory_verified, "errors": errors}, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
