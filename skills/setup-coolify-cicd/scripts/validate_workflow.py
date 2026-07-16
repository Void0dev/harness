#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys


JOB_LINE = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$")
FIELD_LINE = re.compile(r"^    ([A-Za-z0-9_-]+):\s*(.*?)\s*$")
RUN_LINE = re.compile(r"^(\s+)(?:-\s+)?run:\s*(.*?)\s*$")
STEP_USES_LINE = re.compile(r"^\s{6,}(?:-\s+)?uses:\s*(.*?)\s*$")
SECRET_REFERENCE = re.compile(r"secrets\.([A-Za-z0-9_]+)")
TOP_LINE = re.compile(r"^([A-Za-z0-9_-]+):")
RUNNER_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def condition(value: str) -> str:
    value = value.strip()
    if value.startswith("${{") and value.endswith("}}"):
        value = value[3:-2]
    return " ".join(value.strip().replace('"', "'").split())


def needs(value: str) -> set[str]:
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        return {scalar(item) for item in value[1:-1].split(",") if item.strip()}
    return {scalar(value)} if value else set()


def exact_top_block(text: str, name: str) -> list[str] | None:
    lines = text.splitlines()
    indexes = [index for index, line in enumerate(lines) if line == f"{name}:"]
    if len(indexes) != 1:
        return None
    result = []
    for line in lines[indexes[0] + 1:]:
        if line and not line.startswith((" ", "#")):
            break
        if line.strip() and not line.lstrip().startswith("#"):
            result.append(line.rstrip())
    return result


def parse_jobs(text: str) -> dict[str, dict[str, object]]:
    jobs: dict[str, dict[str, object]] = {}
    in_jobs = False
    current = None
    run_block_indent = None
    for line in text.splitlines():
        if line == "jobs:":
            if in_jobs:
                raise ValueError("workflow contains duplicate jobs blocks")
            in_jobs = True
            current = None
            continue
        if not in_jobs:
            continue
        if line and not line.startswith((" ", "#")):
            break

        if current and run_block_indent is not None:
            indent = len(line) - len(line.lstrip())
            if not line.strip() or indent > run_block_indent:
                if line.strip() and not line.lstrip().startswith("#"):
                    jobs[current]["_run_content"].append(line.strip())
                jobs[current]["_lines"].append(line)
                continue
            run_block_indent = None

        job_match = JOB_LINE.match(line)
        if job_match:
            current = job_match.group(1)
            if current in jobs:
                raise ValueError(f"workflow contains duplicate job: {current}")
            jobs[current] = {"_lines": [], "_scalar_runs": [], "_run_content": [], "_step_uses": []}
            continue
        if line.startswith("  ") and not line.startswith("   ") and line.strip() and not line.lstrip().startswith("#"):
            raise ValueError("workflow contains an unsupported or quoted job key")
        if not current:
            continue
        jobs[current]["_lines"].append(line)

        field_match = FIELD_LINE.match(line)
        if field_match:
            jobs[current][field_match.group(1)] = scalar(field_match.group(2))

        run_match = RUN_LINE.match(line)
        if run_match:
            value = scalar(run_match.group(2))
            if value in ("|", ">", "|-"):
                run_block_indent = len(run_match.group(1))
            elif value:
                jobs[current]["_scalar_runs"].append(value)
                jobs[current]["_run_content"].append(value)

        uses_match = STEP_USES_LINE.match(line)
        if uses_match:
            jobs[current]["_step_uses"].append(scalar(uses_match.group(1)))
    return jobs


def job_lines(job: dict[str, object]) -> str:
    return "\n".join(job.get("_lines", []))


def normalized_job_lines(job: dict[str, object], skip_fields: set[str] | None = None) -> list[str]:
    skip_fields = skip_fields or set()
    result = []
    for line in job.get("_lines", []):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        field = FIELD_LINE.match(line)
        if field and field.group(1) in skip_fields:
            continue
        result.append(line.rstrip())
    return result


def yaml_syntax_error(text: str) -> str | None:
    """Parse the workflow with a real YAML parser and fail closed if none exists."""
    try:
        import yaml  # type: ignore[import-not-found]

        yaml.safe_load(text)
        return None
    except ImportError:
        pass
    except Exception as exc:  # PyYAML exposes parser-specific exception classes.
        return f"invalid workflow YAML: {exc}"

    ruby = shutil.which("ruby")
    if not ruby:
        return "workflow verification requires PyYAML or Ruby for fail-closed YAML parsing"
    result = subprocess.run(
        [ruby, "-e", "require 'yaml'; YAML.parse_stream(STDIN.read)"],
        input=text,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        return f"invalid workflow YAML: {detail[-1] if detail else 'parser rejected document'}"
    return None


def fragment_jobs(path: pathlib.Path, replacements: dict[str, str]) -> dict[str, dict[str, object]]:
    text = path.read_text()
    for source, target in replacements.items():
        text = text.replace(source, target)
    indented = "\n".join(f"  {line}" if line else line for line in text.splitlines())
    return parse_jobs(f"jobs:\n{indented}\n")


def validate_job_controls(job_name: str, job: dict[str, object], expected_condition: str, errors: list[str]):
    if condition(str(job.get("if", ""))) != expected_condition:
        errors.append(f"{job_name} must use the exact fail-closed branch/event condition")
    if "continue-on-error:" in job_lines(job):
        errors.append(f"{job_name} must not use continue-on-error")
    if "permissions" in job or "env" in job:
        errors.append(f"{job_name} must not override job-level permissions or environment")
    if not job.get("runs-on"):
        errors.append(f"{job_name} must declare a runner")
    if "steps" not in job:
        errors.append(f"{job_name} must declare executable steps")


def validate(repo: pathlib.Path) -> dict:
    config = json.loads((repo / ".harness" / "config.json").read_text())
    workflow_path = repo / ".github" / "workflows" / "coolify-deploy.yml"
    if not workflow_path.exists():
        return {"verified": False, "workflow": str(workflow_path), "errors": ["missing coolify-deploy.yml"]}
    text = workflow_path.read_text()
    errors = []
    syntax_error = yaml_syntax_error(text)
    if syntax_error:
        errors.append(syntax_error)
    if "\t" in text:
        errors.append("workflow must not contain tab indentation")
    try:
        jobs = parse_jobs(text)
    except ValueError as exc:
        jobs = {}
        errors.append(str(exc))

    if "__HARNESS_" in text:
        errors.append("workflow contains unresolved __HARNESS_* placeholders")

    top_level_lines = [
        line for line in text.splitlines()
        if line.strip() and not line.startswith((" ", "#"))
    ]
    unsupported_top_lines = [line for line in top_level_lines if not TOP_LINE.match(line)]
    if unsupported_top_lines:
        errors.append("workflow contains an unsupported or quoted top-level key")
    top_keys = [match.group(1) for line in top_level_lines if (match := TOP_LINE.match(line))]
    expected_top_keys = {"name", "on", "permissions", "concurrency", "jobs"}
    if set(top_keys) != expected_top_keys or len(top_keys) != len(expected_top_keys):
        errors.append("workflow top-level keys must be exactly name, on, permissions, concurrency, and jobs")

    on_block = exact_top_block(text, "on")
    expected_on = {"  push:", "    branches: [stage]", "  workflow_dispatch:"}
    if on_block is None or set(on_block) != expected_on or len(on_block) != len(expected_on):
        errors.append("workflow triggers must be exactly stage push plus workflow_dispatch")
    permissions_block = exact_top_block(text, "permissions")
    if permissions_block != ["  contents: read"]:
        errors.append("workflow permissions must be exactly contents: read")
    concurrency_block = exact_top_block(text, "concurrency")
    if concurrency_block != ["  group: coolify-${{ github.ref_name }}", "  cancel-in-progress: false"]:
        errors.append("workflow concurrency contract is invalid")

    required_jobs = ("verify", "deploy-stage", "deploy-production")
    for job_name in required_jobs:
        if job_name not in jobs:
            errors.append(f"missing job: {job_name}")
    verify = jobs.get("verify")
    if verify and verify.get("uses") != "./.github/workflows/ci.yml":
        errors.append("verify job must call ./.github/workflows/ci.yml")

    stack = config.get("project", {}).get("stack")
    supported_stacks = {"nest-postgres", "convex", "hybrid"}
    if stack not in supported_stacks:
        errors.append("project.stack must be nest-postgres, convex, or hybrid")
    commands = config.get("commands", {})
    install_command = commands.get("install")
    gate_runners = config.get("deployment", {}).get("gateRunners", {
        "stage": "ubuntu-latest",
        "production": "ubuntu-latest",
    })
    if not isinstance(gate_runners, dict):
        errors.append("deployment.gateRunners must map stage and production to reviewed runner labels")
        gate_runners = {}
    gates = {"stage": [], "production": []}
    gate_commands = {}
    gate_secrets = {}
    if stack in ("nest-postgres", "hybrid"):
        gates["stage"].append("migration-stage")
        gates["production"].append("migration-production")
        gate_commands.update({
            "migration-stage": commands.get("migrateStage"),
            "migration-production": commands.get("migrateProduction"),
        })
        gate_secrets.update({"migration-stage": "DATABASE_URL", "migration-production": "DATABASE_URL"})
    if stack in ("convex", "hybrid"):
        gates["stage"].append("backend-stage")
        gates["production"].append("backend-production")
        gate_commands.update({
            "backend-stage": commands.get("deployStage"),
            "backend-production": commands.get("deployProduction"),
        })
        gate_secrets.update({"backend-stage": "CONVEX_DEPLOY_KEY", "backend-production": "CONVEX_DEPLOY_KEY"})

    expected_jobs = {"verify", "deploy-stage", "deploy-production", *gates["stage"], *gates["production"]}
    if set(jobs) != expected_jobs:
        errors.append("workflow contains missing or unexpected jobs")

    assets = pathlib.Path(__file__).resolve().parents[1] / "assets"
    base_jobs = parse_jobs((assets / "coolify-deploy.yml").read_text())
    if verify and normalized_job_lines(verify) != normalized_job_lines(base_jobs["verify"]):
        errors.append("verify differs from the reviewed reusable-workflow template")

    expected_gate_jobs = {}
    if stack in ("nest-postgres", "hybrid"):
        expected_gate_jobs.update(fragment_jobs(assets / "nest-migration-jobs.yml", {
            "npm ci": install_command,
            "__HARNESS_MIGRATE_STAGE__": commands.get("migrateStage"),
            "__HARNESS_MIGRATE_PRODUCTION__": commands.get("migrateProduction"),
        }))
    if stack in ("convex", "hybrid"):
        expected_gate_jobs.update(fragment_jobs(assets / "convex-delivery-jobs.yml", {
            "npm ci": install_command,
            "__HARNESS_CONVEX_DEPLOY_STAGE__": commands.get("deployStage"),
            "__HARNESS_CONVEX_DEPLOY_PRODUCTION__": commands.get("deployProduction"),
        }))

    conditions = {
        "stage": "github.ref_name == 'stage'",
        "production": "github.event_name == 'workflow_dispatch' && github.ref_name == 'main'",
    }
    for lane, gate_jobs in gates.items():
        for job_name in gate_jobs:
            job = jobs.get(job_name)
            if not job:
                errors.append(f"missing stack gate job: {job_name}")
                continue
            validate_job_controls(job_name, job, conditions[lane], errors)
            expected_runner = gate_runners.get(lane)
            if not isinstance(expected_runner, str) or not RUNNER_LABEL.fullmatch(expected_runner):
                errors.append(f"deployment.gateRunners.{lane} must be a literal reviewed runner label")
            elif scalar(str(job.get("runs-on", ""))) != expected_runner:
                errors.append(f"{job_name} must use the configured {lane} gate runner")
            if "verify" not in needs(str(job.get("needs", ""))):
                errors.append(f"{job_name} must depend on verify")
            if job.get("environment") != lane:
                errors.append(f"{job_name} must use environment: {lane}")
            expected_runs = [install_command, gate_commands.get(job_name)]
            if not all(expected_runs) or job.get("_scalar_runs") != expected_runs:
                errors.append(f"{job_name} must run exactly commands.install then its configured stack command")
            actions = job.get("_step_uses", [])
            if actions != ["actions/checkout@v4", "actions/setup-node@v4"]:
                errors.append(f"{job_name} must use only checkout and setup-node actions")
            if job.get("_run_content") != expected_runs:
                errors.append(f"{job_name} contains an unexpected executable command")
            secret_refs = SECRET_REFERENCE.findall(job_lines(job))
            if secret_refs != [gate_secrets[job_name]]:
                errors.append(f"{job_name} must reference only secrets.{gate_secrets[job_name]}")
            expected_gate = expected_gate_jobs.get(job_name)
            if not expected_gate or normalized_job_lines(job, {"runs-on"}) != normalized_job_lines(expected_gate, {"runs-on"}):
                errors.append(f"{job_name} differs from the reviewed gate template")

        deploy_name = f"deploy-{lane}"
        deploy = jobs.get(deploy_name)
        if not deploy:
            continue
        validate_job_controls(deploy_name, deploy, conditions[lane], errors)
        if deploy.get("environment") != lane:
            errors.append(f"{deploy_name} must use environment: {lane}")
        expected_needs = set(gate_jobs or ["verify"])
        actual_needs = needs(str(deploy.get("needs", "")))
        if actual_needs != expected_needs:
            errors.append(f"{deploy_name} dependencies must be exactly: {', '.join(sorted(expected_needs))}")
        run_content = "\n".join(deploy.get("_run_content", []))
        required_delivery_tokens = ("/api/v1/deploy\"", "/api/v1/deployments/", "GITHUB_SHA", "HEALTH_URL")
        if not all(token in run_content for token in required_delivery_tokens):
            errors.append(f"{deploy_name} must deploy, poll the immutable commit, and smoke health")
        if normalized_job_lines(deploy, {"needs"}) != normalized_job_lines(base_jobs[deploy_name], {"needs"}):
            errors.append(f"{deploy_name} differs from the reviewed deploy/poll/smoke template")
        secret_refs = SECRET_REFERENCE.findall(job_lines(deploy))
        if secret_refs != ["COOLIFY_TOKEN"]:
            errors.append(f"{deploy_name} must reference only secrets.COOLIFY_TOKEN")

    return {
        "verified": not errors,
        "workflow": str(workflow_path),
        "stack": stack,
        "jobs": sorted(jobs),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", nargs="?", default=".")
    args = parser.parse_args()
    report = validate(pathlib.Path(args.repo).resolve())
    print(json.dumps(report, indent=2))
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
