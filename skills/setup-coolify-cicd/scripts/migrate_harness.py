#!/usr/bin/env python3
"""Dry-run or atomically write the canonical harness v2 contract."""

import argparse
import hashlib
import json
import pathlib
import sys


SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))
from harness_config import compile_workflows, normalize_config  # noqa: E402
from harness_io import atomic_write_files, read_repository_file, recover_pending_write, repository_write_lock, validate_write_paths  # noqa: E402


def rendered_files(root: pathlib.Path) -> tuple[int, dict[pathlib.Path, bytes]]:
    config_path = root / ".harness" / "config.json"
    destinations = (
        config_path,
        root / ".github" / "workflows" / "ci.yml",
        root / ".github" / "workflows" / "coolify-deploy.yml",
        root / ".github" / "workflows" / "backend-prepare.yml",
        root / ".github" / "workflows" / "coolify-rollback.yml",
        root / ".github" / "workflows" / "bootstrap-deployment-evidence.yml",
    )
    validate_write_paths(root, destinations)
    raw_bytes = read_repository_file(root, config_path)
    assert raw_bytes is not None
    raw = json.loads(raw_bytes)
    if not isinstance(raw, dict):
        raise ValueError("harness config must be a JSON object")
    source_version = raw.get("schemaVersion")
    canonical = normalize_config(raw)
    workflows = compile_workflows(canonical, SKILL_DIR / "assets")
    return source_version, {
        config_path: (json.dumps(canonical, indent=2) + "\n").encode(),
        destinations[1]: workflows["ci.yml"].encode(),
        destinations[2]: workflows[
            "coolify-deploy.yml"
        ].encode(),
        destinations[3]: workflows["backend-prepare.yml"].encode(),
        destinations[4]: workflows["coolify-rollback.yml"].encode(),
        destinations[5]: workflows["bootstrap-deployment-evidence.yml"].encode(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", nargs="?", default=".")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path(args.repo).resolve()
    if args.write:
        with repository_write_lock(root):
            recovered = recover_pending_write(root)
            source_version, files = rendered_files(root)
            report_files = file_report(root, files)
            atomic_write_files(root, files)
    else:
        recovered = False
        source_version, files = rendered_files(root)
        report_files = file_report(root, files)
    print(json.dumps({
        "dryRun": args.dry_run,
        "sourceSchemaVersion": source_version,
        "targetSchemaVersion": 2,
        "recoveredInterruptedWrite": recovered,
        "files": report_files,
    }, indent=2))
    return 0


def file_report(root: pathlib.Path, files: dict[pathlib.Path, bytes]) -> list[dict]:
    report = []
    for path, content in files.items():
        current = read_repository_file(root, path, missing_ok=True)
        report.append({
            "path": str(path.relative_to(root)),
            "changed": current != content,
            "sha256": hashlib.sha256(content).hexdigest(),
        })
    return report


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
