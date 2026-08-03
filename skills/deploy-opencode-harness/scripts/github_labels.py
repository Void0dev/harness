#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys

LABELS = {
    "ai:backlog": ("6f42c1", "Agent task not yet approved"),
    "ai:todo": ("0e8a16", "Ready for issue harness pickup"),
    "ai:running": ("fbca04", "Issue harness is working"),
    "ai:finished": ("1d76db", "Issue harness opened a pull request"),
    "ai:needs-human": ("d93f0b", "Agent needs human input or repair"),
    "production:diagnose": ("5319e7", "Read-only production diagnosis request"),
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repository")
    parser.add_argument("mode", choices=("plan", "apply"))
    parser.add_argument("--allow-external-writes", action="store_true")
    args = parser.parse_args()
    plan = [{"name": name, "color": color, "description": description} for name, (color, description) in LABELS.items()]
    if args.mode == "plan":
        print(json.dumps({"repository": args.repository, "labels": plan}, indent=2))
        return 0
    if not args.allow_external_writes:
        print("ERROR: apply requires --allow-external-writes", file=sys.stderr)
        return 2
    for item in plan:
        subprocess.run([
            "gh", "label", "create", item["name"], "--repo", args.repository,
            "--color", item["color"], "--description", item["description"], "--force",
        ], check=True)
    print(json.dumps({"repository": args.repository, "labelsReconciled": list(LABELS)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
