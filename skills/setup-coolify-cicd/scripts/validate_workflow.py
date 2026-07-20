#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from harness_config import RUNNER_LABEL, capability_kinds, compile_workflows, load_config, single_capability  # noqa: E402


JOB_LINE = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$")
FIELD_LINE = re.compile(r"^    ([A-Za-z0-9_-]+):\s*(.*?)\s*$")
RUN_LINE = re.compile(r"^(\s+)(?:-\s+)?run:\s*(.*?)\s*$")
STEP_USES_LINE = re.compile(r"^\s{6,}(?:-\s+)?uses:\s*(.*?)\s*$")
SECRET_REFERENCE = re.compile(r"secrets\.([A-Za-z0-9_]+)")
REMOTE_ACTION_REFERENCE = re.compile(r"uses:\s+([^\s]+)")
FULL_ACTION_PIN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")
CHECKOUT_ACTION = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5"
SETUP_NODE_ACTION = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
TOP_LINE = re.compile(r"^([A-Za-z0-9_-]+):")


def scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return value
        return decoded if isinstance(decoded, str) else value
    if len(value) >= 2 and value[0] == value[-1] == "'":
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


def direct_top_block_keys(text: str, name: str) -> list[str]:
    block = exact_top_block(text, name) or []
    keys = []
    for line in block:
        if line.startswith("  ") and not line.startswith("   ") and line.endswith(":"):
            keys.append(line.strip()[:-1])
    return keys


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
    workflow_path = repo / ".github" / "workflows" / "coolify-deploy.yml"
    try:
        _, config = load_config(repo)
    except (ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
        return {"verified": False, "workflow": str(workflow_path), "capabilities": [], "jobs": [], "errors": [str(exc)]}
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
    if direct_top_block_keys(text, "on") != ["workflow_run", "workflow_dispatch"]:
        errors.append("workflow triggers must be exactly CI workflow_run plus workflow_dispatch")
    permissions_block = exact_top_block(text, "permissions")
    expected_permissions = [
        "  actions: read",
        "  attestations: write",
        "  contents: read",
        "  id-token: write",
    ]
    if permissions_block != expected_permissions:
        errors.append("workflow permissions must be exact read plus attestation publication scopes")
    concurrency_block = exact_top_block(text, "concurrency")
    if concurrency_block != [
        "  group: coolify-${{ github.workflow }}-${{ github.event_name }}",
        "  cancel-in-progress: false",
    ]:
        errors.append("workflow concurrency contract is invalid")

    required_jobs = ("verify", "deploy-stage", "deploy-production")
    for job_name in required_jobs:
        if job_name not in jobs:
            errors.append(f"missing job: {job_name}")
    verify = jobs.get("verify")
    if verify and verify.get("uses") != "./.github/workflows/ci.yml":
        errors.append("verify job must call ./.github/workflows/ci.yml")

    kinds = capability_kinds(config)
    postgres = single_capability(config, "coolify.postgresql") if "coolify.postgresql" in kinds else None
    convex = single_capability(config, "convex.deployment") if "convex.deployment" in kinds else None
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
    if postgres:
        postgres_workflow = postgres["workflow"]
        gates["stage"].append(postgres_workflow.get("stageGate"))
        gates["production"].append(postgres_workflow.get("productionGate"))
        gate_commands.update({
            postgres_workflow.get("stageGate"): postgres["commands"].get("deployStage"),
            postgres_workflow.get("productionGate"): postgres["commands"].get("deployProduction"),
        })
        gate_secrets.update({
            postgres_workflow.get("stageGate"): postgres["bindings"]["stage"].get("workflowSecretName"),
            postgres_workflow.get("productionGate"): postgres["bindings"]["production"].get("workflowSecretName"),
        })
    if convex:
        convex_workflow = convex["workflow"]
        gates["stage"].append(convex_workflow.get("stageGate"))
        gates["production"].append(convex_workflow.get("productionGate"))
        gate_commands.update({
            convex_workflow.get("stageGate"): convex["commands"].get("deployStage"),
            convex_workflow.get("productionGate"): convex["commands"].get("deployProduction"),
        })
        gate_secrets.update({
            convex_workflow.get("stageGate"): convex["bindings"]["stage"].get("workflowSecretName"),
            convex_workflow.get("productionGate"): convex["bindings"]["production"].get("workflowSecretName"),
        })

    expected_jobs = {"verify", "deploy-stage", "deploy-production", *gates["stage"], *gates["production"]}
    if set(jobs) != expected_jobs:
        errors.append("workflow contains missing or unexpected jobs")

    assets = pathlib.Path(__file__).resolve().parents[1] / "assets"
    compiled_workflows = compile_workflows(config, assets)
    expected_delivery = compiled_workflows["coolify-deploy.yml"]
    if text != expected_delivery:
        errors.append("delivery workflow differs from the exact canonical compilation")
    base_jobs = parse_jobs((assets / "coolify-deploy.yml").read_text())
    ci_path = repo / ".github" / "workflows" / "ci.yml"
    expected_ci = compiled_workflows["ci.yml"]
    if not ci_path.is_file() or ci_path.read_text() != expected_ci:
        errors.append("CI workflow differs from exact configured gates")
    auxiliary_texts = []
    auxiliary_specs = (
        (
            "backend-prepare.yml",
            "backend preparation workflow differs from exact canonical compilation",
        ),
        (
            "coolify-rollback.yml",
            "rollback workflow differs from exact canonical compilation",
        ),
        (
            "bootstrap-deployment-evidence.yml",
            "bootstrap workflow differs from exact canonical compilation",
        ),
    )
    for name, mismatch_error in auxiliary_specs:
        path = repo / ".github" / "workflows" / name
        expected = compiled_workflows[name]
        if not path.is_file():
            errors.append(f"missing canonical protected workflow: {name}")
            continue
        auxiliary_text = path.read_text()
        auxiliary_texts.append(auxiliary_text)
        if auxiliary_text != expected:
            errors.append(mismatch_error)
        auxiliary_syntax_error = yaml_syntax_error(auxiliary_text)
        if auxiliary_syntax_error:
            errors.append(f"{name}: {auxiliary_syntax_error}")
        if direct_top_block_keys(auxiliary_text, "on") != ["workflow_dispatch"]:
            errors.append(f"{name} trigger must be exactly workflow_dispatch")
        if exact_top_block(auxiliary_text, "permissions") != expected_permissions:
            errors.append(f"{name} permissions must be exact read plus attestation publication scopes")
        try:
            auxiliary_jobs = parse_jobs(auxiliary_text)
        except ValueError as exc:
            auxiliary_jobs = {}
            errors.append(f"{name}: {exc}")
        expected_environment = "${{ inputs.lane }}" if name == "bootstrap-deployment-evidence.yml" else "production"
        if not auxiliary_jobs or any(job.get("environment") != expected_environment for job in auxiliary_jobs.values()):
            errors.append(f"{name} jobs must use the exact protected environment contract")

    for workflow_text in (
        text,
        ci_path.read_text() if ci_path.is_file() else "",
        *auxiliary_texts,
    ):
        for reference in REMOTE_ACTION_REFERENCE.findall(workflow_text):
            if not reference.startswith("./") and not FULL_ACTION_PIN.fullmatch(reference):
                errors.append(f"remote action is not pinned to a full commit SHA: {reference}")
    installed_helper = repo / ".harness" / "deploy_exact_revision.py"
    reviewed_helper = assets / "deploy_exact_revision.py"
    if not installed_helper.is_file():
        errors.append("missing reviewed .harness/deploy_exact_revision.py")
    elif installed_helper.read_bytes() != reviewed_helper.read_bytes():
        errors.append("exact revision helper differs from the reviewed template")
    installed_client = repo / ".harness" / "coolify_client.py"
    reviewed_client = assets / "coolify_client.py"
    if not installed_client.is_file():
        errors.append("missing reviewed .harness/coolify_client.py")
    elif installed_client.read_bytes() != reviewed_client.read_bytes():
        errors.append("Coolify client differs from the reviewed template")
    if verify and normalized_job_lines(verify) != normalized_job_lines(base_jobs["verify"]):
        errors.append("verify differs from the reviewed reusable-workflow template")

    compiled_jobs = parse_jobs(expected_delivery)
    expected_gate_jobs = {
        job_name: job
        for job_name, job in compiled_jobs.items()
        if job_name not in base_jobs
    }

    conditions = {
        "stage": "github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'stage' && github.event.workflow_run.conclusion == 'success'",
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
            expected_gate = expected_gate_jobs.get(job_name)
            expected_runs = (
                expected_gate.get("_scalar_runs", []) if lane == "production" and expected_gate
                else [install_command, gate_commands.get(job_name)]
            )
            if not all(expected_runs) or job.get("_scalar_runs") != expected_runs:
                if lane == "production":
                    errors.append(f"{job_name} must validate only canonical prepared backend evidence")
                else:
                    errors.append(f"{job_name} must run exactly commands.install then its configured stack command")
            actions = job.get("_step_uses", [])
            expected_actions = [CHECKOUT_ACTION] if lane == "production" else [CHECKOUT_ACTION, SETUP_NODE_ACTION]
            if actions != expected_actions:
                errors.append(f"{job_name} uses actions outside the reviewed lane template")
            if job.get("_run_content") != expected_runs:
                errors.append(f"{job_name} contains an unexpected executable command")
            secret_refs = SECRET_REFERENCE.findall(job_lines(job))
            expected_secrets = [] if lane == "production" else [gate_secrets[job_name]]
            if secret_refs != expected_secrets:
                errors.append(f"{job_name} references credentials outside the reviewed lane template")
            if not expected_gate or normalized_job_lines(job, {"runs-on"}) != normalized_job_lines(expected_gate, {"runs-on"}):
                errors.append(f"{job_name} differs from the reviewed gate template")

        deploy_name = f"deploy-{lane}"
        deploy = jobs.get(deploy_name)
        if not deploy:
            continue
        deploy_condition = (
            "github.event_name == 'workflow_dispatch' && github.ref_name == 'main'"
            if lane == "production"
            else conditions[lane]
        )
        validate_job_controls(deploy_name, deploy, deploy_condition, errors)
        if deploy.get("environment") != lane:
            errors.append(f"{deploy_name} must use environment: {lane}")
        expected_needs = set(gate_jobs or ["verify"])
        actual_needs = needs(str(deploy.get("needs", "")))
        if actual_needs != expected_needs:
            errors.append(f"{deploy_name} dependencies must be exactly: {', '.join(sorted(expected_needs))}")
        run_content = "\n".join(deploy.get("_run_content", []))
        required_delivery_tokens = (
            ".harness/deploy_exact_revision.py",
            ".harness/evidence_ledger.py",
            "--resource-uuid",
            "--revision",
            "--health-url",
        )
        if not all(token in run_content for token in required_delivery_tokens):
            errors.append(f"{deploy_name} must deploy, poll the immutable commit, and smoke health")
        if normalized_job_lines(deploy, {"needs"}) != normalized_job_lines(base_jobs[deploy_name], {"needs"}):
            errors.append(f"{deploy_name} differs from the reviewed deploy/poll/smoke template")
        secret_refs = SECRET_REFERENCE.findall(job_lines(deploy))
        if secret_refs != ["COOLIFY_PIN_TOKEN", "COOLIFY_DEPLOY_TOKEN"]:
            errors.append(
                f"{deploy_name} must reference only the separate pin and deploy Coolify tokens"
            )

    return {
        "verified": not errors,
        "workflow": str(workflow_path),
        "capabilities": sorted(kinds),
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
