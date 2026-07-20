"""Exact compiler for reviewed CI and delivery workflow assets."""

from __future__ import annotations

import json
import pathlib


KNOWN_CAPABILITY_KINDS = frozenset({
    "coolify.application",
    "coolify.postgresql",
    "convex.deployment",
})


def compile_workflows(config: dict, assets_dir: pathlib.Path) -> dict[str, str]:
    from harness_config import RUNNER_LABEL, capability_kinds, single_capability
    from harness_safety import validate_harness_safety

    validate_harness_safety(config)

    ci = (assets_dir / "ci.yml").read_text()
    for key in ("install", "test", "lint", "typecheck", "build"):
        ci = _replace_placeholder(
            ci,
            f"__HARNESS_{key.upper()}__",
            _yaml_string(config["commands"][key]),
        )

    delivery = (assets_dir / "coolify-deploy.yml").read_text()
    fragments: list[str] = []
    stage_gates: list[str] = []
    production_gates: list[str] = []
    install_command = config["commands"]["install"]
    gate_runners = config["deployment"].get("gateRunners", {
        "stage": "ubuntu-latest",
        "production": "ubuntu-latest",
    })
    if set(gate_runners) != {"stage", "production"} or any(
        not isinstance(gate_runners[lane], str)
        or not RUNNER_LABEL.fullmatch(gate_runners[lane])
        for lane in ("stage", "production")
    ):
        raise ValueError("deployment.gateRunners must define literal stage and production runner labels")
    kinds = capability_kinds(config)
    unknown = kinds - KNOWN_CAPABILITY_KINDS
    if unknown:
        raise ValueError(
            "no reviewed workflow compiler/verifier is registered for capability kinds: "
            + ", ".join(sorted(unknown))
        )
    if "coolify.postgresql" in kinds:
        postgres = single_capability(config, "coolify.postgresql")
        _require_workflow_gates(postgres, "migration-stage", "migration-production")
        fragment = (assets_dir / "nest-migration-jobs.yml").read_text()
        fragment = _replace_all_exact(fragment, "npm ci", _yaml_string(install_command), 1)
        fragment = _compile_gate_runners(fragment, gate_runners)
        fragment = _replace_placeholder(
            fragment,
            "__HARNESS_MIGRATE_STAGE__",
            _yaml_string(postgres["commands"]["deployStage"]),
        )
        fragment = _replace_placeholder(
            fragment,
            "__HARNESS_MIGRATE_PRODUCTION__",
            "production preparation command omitted from main delivery",
        )
        fragments.append(fragment)
        stage_gates.append("migration-stage")
        production_gates.append("migration-production")
    if "convex.deployment" in kinds:
        convex = single_capability(config, "convex.deployment")
        _require_workflow_gates(convex, "backend-stage", "backend-production")
        fragment = (assets_dir / "convex-delivery-jobs.yml").read_text()
        fragment = _replace_all_exact(fragment, "npm ci", _yaml_string(install_command), 1)
        fragment = _compile_gate_runners(fragment, gate_runners)
        fragment = _replace_placeholder(
            fragment,
            "__HARNESS_CONVEX_DEPLOY_STAGE__",
            _yaml_string(convex["commands"]["deployStage"]),
        )
        fragment = _replace_placeholder(
            fragment,
            "__HARNESS_CONVEX_DEPLOY_PRODUCTION__",
            "production preparation command omitted from main delivery",
        )
        if "coolify.postgresql" in kinds:
            fragment = _replace_first(fragment, "needs: verify", "needs: [verify, migration-stage]")
            fragment = _replace_first(fragment, "needs: verify", "needs: [verify, migration-production]")
        fragments.append(fragment)
        stage_gates.append("backend-stage")
        production_gates.append("backend-production")

    if stage_gates:
        delivery = _replace_first(delivery, "needs: verify", f"needs: {_needs_value(stage_gates)}")
        delivery = _replace_first(
            delivery,
            "needs: verify",
            f"needs: {_needs_value(production_gates)}",
        )
    if fragments:
        indented = "\n".join(
            f"  {line}" if line else line
            for fragment in fragments
            for line in fragment.splitlines()
        )
        delivery = _replace_first(delivery, "jobs:\n", f"jobs:\n{indented}\n")
    backend_prepare = compile_backend_prepare_workflow(config, assets_dir)
    rollback = (assets_dir / "coolify-rollback.yml").read_text()
    rollback = _replace_first(
        rollback,
        "runs-on: ubuntu-latest",
        f"runs-on: {gate_runners['production']}",
    )
    bootstrap = (assets_dir / "bootstrap-deployment-evidence.yml").read_text()
    bootstrap = _replace_first(
        bootstrap,
        "runs-on: ubuntu-latest",
        f"runs-on: {gate_runners['production']}",
    )
    compiled = {
        "ci.yml": ci,
        "coolify-deploy.yml": delivery,
        "backend-prepare.yml": backend_prepare,
        "coolify-rollback.yml": rollback,
        "bootstrap-deployment-evidence.yml": bootstrap,
    }
    if any("__HARNESS_" in text for text in compiled.values()):
        raise ValueError("compiled workflow contains unresolved __HARNESS_* placeholders")
    return compiled


def compile_backend_prepare_workflow(config: dict, assets_dir: pathlib.Path) -> str:
    """Compile the separately approved expand-only production preparation workflow."""
    from harness_config import capability_kinds, single_capability
    from harness_safety import validate_harness_safety

    validate_harness_safety(config)

    kinds = capability_kinds(config)
    unknown = kinds - KNOWN_CAPABILITY_KINDS
    if unknown:
        raise ValueError("unregistered capability kind in backend preparation workflow")
    install = _yaml_string(config["commands"]["install"])
    runner = config["deployment"]["gateRunners"]["production"]
    fragments = []
    if "coolify.postgresql" in kinds:
        postgres = single_capability(config, "coolify.postgresql")
        fragment = (assets_dir / "backend-prepare-postgres.yml").read_text()
        fragment = _replace_placeholder(fragment, "__HARNESS_PRODUCTION_RUNNER__", runner)
        fragment = _replace_placeholder(fragment, "__HARNESS_INSTALL__", install)
        fragment = _replace_placeholder(
            fragment, "__HARNESS_PREPARE_POSTGRES__", _yaml_string(postgres["commands"]["deployProduction"])
        )
        fragments.append(fragment)
    if "convex.deployment" in kinds:
        convex = single_capability(config, "convex.deployment")
        fragment = (assets_dir / "backend-prepare-convex.yml").read_text()
        fragment = _replace_placeholder(fragment, "__HARNESS_PRODUCTION_RUNNER__", runner)
        fragment = _replace_placeholder(fragment, "__HARNESS_INSTALL__", install)
        fragment = _replace_placeholder(
            fragment, "__HARNESS_PREPARE_CONVEX__", _yaml_string(convex["commands"]["deployProduction"])
        )
        needs = "needs: postgres-prepare-production" if "coolify.postgresql" in kinds else ""
        fragment = _replace_placeholder(fragment, "__HARNESS_CONVEX_NEEDS__", needs)
        fragments.append(fragment)
    if fragments:
        jobs = "\n".join(
            f"  {line}" if line else line
            for fragment in fragments
            for line in fragment.splitlines()
        )
    else:
        jobs = (
            "  no-backend-preparation:\n"
            "    if: ${{ false }}\n"
            f"    runs-on: {runner}\n"
            "    environment: production\n"
            "    steps:\n"
            "      - run: exit 2\n"
        )
    workflow = _replace_placeholder(
        (assets_dir / "backend-prepare.yml").read_text(),
        "__HARNESS_BACKEND_PREPARE_JOBS__",
        jobs,
    )
    workflow = _replace_placeholder(
        workflow,
        "__HARNESS_BACKEND_AGGREGATE_NEEDS__",
        _needs_value([
            name for name, kind in (
                ("postgres-prepare-production", "coolify.postgresql"),
                ("convex-prepare-production", "convex.deployment"),
            )
            if kind in kinds
        ]) if kinds.intersection({"coolify.postgresql", "convex.deployment"}) else "no-backend-preparation",
    )
    workflow = _replace_placeholder(
        workflow,
        "__HARNESS_PRODUCTION_RUNNER__",
        runner,
    )
    if "__HARNESS_" in workflow:
        raise ValueError("compiled backend preparation workflow contains an unresolved placeholder")
    return workflow


def _replace_placeholder(text: str, placeholder: str, value: str) -> str:
    count = text.count(placeholder)
    if count != 1:
        raise ValueError(f"reviewed workflow must contain exactly one {placeholder!r} placeholder")
    return text.replace(placeholder, value, 1)


def _yaml_string(value: str) -> str:
    """JSON strings are unambiguous YAML double-quoted string scalars."""

    return json.dumps(value, ensure_ascii=True)


def _replace_first(text: str, source: str, replacement: str) -> str:
    if source not in text:
        raise ValueError(f"reviewed workflow is missing required marker: {source}")
    return text.replace(source, replacement, 1)


def _replace_all_exact(text: str, source: str, replacement: str, count: int) -> str:
    if text.count(source) != count:
        raise ValueError(f"reviewed workflow must contain exactly {count} {source!r} markers")
    return text.replace(source, replacement)


def _needs_value(gates: list[str]) -> str:
    return gates[0] if len(gates) == 1 else f"[{', '.join(gates)}]"


def _require_workflow_gates(capability: dict, stage: str, production: str) -> None:
    if capability["workflow"] != {"stageGate": stage, "productionGate": production}:
        raise ValueError(
            f"capability {capability['id']} workflow gates must match the reviewed compiler"
        )


def _compile_gate_runners(fragment: str, runners: dict[str, str]) -> str:
    fragment = _replace_first(
        fragment,
        "runs-on: ubuntu-latest",
        f"runs-on: {runners['stage']}",
    )
    return _replace_first(
        fragment,
        "runs-on: ubuntu-latest",
        f"runs-on: {runners['production']}",
    )
