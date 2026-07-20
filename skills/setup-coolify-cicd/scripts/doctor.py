#!/usr/bin/env python3
import argparse
import json
import pathlib
import shlex
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from harness_config import capability_kinds, load_config, single_capability  # noqa: E402
from harness_safety import validate_harness_safety  # noqa: E402


def detect(root: pathlib.Path, run_commands: bool) -> dict:
    package = root / "package.json"
    text = package.read_text(errors="ignore") if package.exists() else ""
    stacks = []
    if "convex" in text or (root / "convex").exists():
        stacks.append("convex")
    if "@nestjs/" in text or any(root.glob("**/nest-cli.json")):
        stacks.append("nest")
    if any(token in text for token in ('pg"', "postgres", "typeorm", "prisma")):
        stacks.append("postgres")

    lockfiles = [name for name in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "uv.lock", "poetry.lock") if (root / name).exists()]
    config_path = root / ".harness" / "config.json"
    errors, warnings = [], []
    config = None
    if not config_path.exists():
        errors.append("missing .harness/config.json")
    else:
        try:
            _, config = load_config(root)
            validate_harness_safety(config)
        except Exception as exc:
            errors.append(f"invalid .harness/config.json: {exc}")

    command_results = []
    if config:
        commands = config.get("commands", {})
        kinds = capability_kinds(config)
        capability_commands = [
            (f"{label}.check", single_capability(config, kind)["commands"]["check"])
            for kind, label in (
                ("coolify.postgresql", "postgres"),
                ("convex.deployment", "convex"),
            )
            if kind in kinds
        ]
        if run_commands:
            command_plan = [(key, commands.get(key)) for key in ("install", "test", "lint", "typecheck", "build", "smoke")]
            command_plan.extend(capability_commands)
            for key, command in command_plan:
                if not command:
                    continue
                completed = subprocess.run(
                    shlex.split(command), cwd=root, text=True, capture_output=True, timeout=900,
                )
                command_results.append({"name": key, "command": command, "exitCode": completed.returncode})
                if completed.returncode != 0:
                    errors.append(f"command failed: {key} ({command})")
        serialized = json.dumps(config).lower()
        for marker in ("token", "password", "secret", "api_key", "apikey"):
            if f'"{marker}"' in serialized:
                warnings.append(f"review config for possible secret-bearing key: {marker}")

    if not lockfiles:
        errors.append("missing dependency lockfile")
    if not package.exists() and not (root / "pyproject.toml").exists():
        warnings.append("no supported project manifest detected")
    service_root = root / str((config or {}).get("project", {}).get("serviceRoot", "."))
    if not any((service_root / name).exists() for name in ("Dockerfile", "docker-compose.yml", "compose.yml", "nixpacks.toml")):
        errors.append("missing deployment contract at the configured service root")
    if not (root / ".env.example").exists():
        errors.append("missing .env.example")
    if not (root / ".github" / "workflows" / "ci.yml").exists():
        errors.append("missing .github/workflows/ci.yml")
    health_path = (config or {}).get("runtime", {}).get("healthPath")
    if health_path and not source_contains(root, health_path):
        errors.append(f"health path {health_path!r} was not found in repository source/configuration")

    return {
        "root": str(root),
        "stacks": stacks or ["unknown"],
        "lockfiles": lockfiles,
        "checks": {"config": config_path.exists(), "prompt": (root / ".sandcastle" / "prompt.md").exists()},
        "commandResults": command_results,
        "commandsVerified": run_commands and not any(item["exitCode"] for item in command_results),
        "contractReady": not errors,
        "errors": errors,
        "warnings": warnings,
        "ready": not errors and run_commands,
    }


def source_contains(root: pathlib.Path, needle: str) -> bool:
    allowed = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".json", ".yml", ".yaml", ".toml"}
    ignored = {".git", ".harness", "node_modules", "dist", "build", ".next", ".convex"}
    checked = 0
    for file in root.rglob("*"):
        if not file.is_file() or file.suffix not in allowed or ignored.intersection(file.parts):
            continue
        checked += 1
        if checked > 5000:
            break
        try:
            if needle in file.read_text(errors="ignore"):
                return True
        except OSError:
            continue
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", nargs="?", default=".")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--run-commands", action="store_true")
    args = parser.parse_args()
    report = detect(pathlib.Path(args.repo).resolve(), args.run_commands)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("READY" if report["ready"] else "NOT READY")
        for item in report["errors"]:
            print(f"ERROR: {item}")
        for item in report["warnings"]:
            print(f"WARN: {item}")
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
