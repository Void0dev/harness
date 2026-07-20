"""Schema loading and capability normalization for the project harness."""

from __future__ import annotations

import copy
import json
import pathlib
import re
import sys


MODULE_DIR = pathlib.Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))
from harness_repository_contract import (  # noqa: E402
    LANES,
    RUNNER_LABEL,
    validate_repository_contract,
    validate_schema_header,
)


CAPABILITY_KIND = re.compile(r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$")
CAPABILITY_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
WORKFLOW_GATE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")

_EVIDENCE_EXPORTS = {
    "COOLIFY_INVENTORY_CONTRACT",
    "EvidenceContract",
    "EvidenceMetadata",
}


def __getattr__(name: str):
    """Keep schema loading standalone while preserving the setup facade exports."""
    if name in _EVIDENCE_EXPORTS:
        import harness_evidence

        return getattr(harness_evidence, name)
    raise AttributeError(name)


def load_config(root: pathlib.Path) -> tuple[pathlib.Path, dict]:
    path = root / ".harness" / "config.json"
    return path, normalize_config(json.loads(path.read_text()))


def normalize_config(raw: dict) -> dict:
    version = validate_schema_header(raw)
    if version == 1:
        normalized = _migrate_v1(raw)
    elif version == 2:
        normalized = copy.deepcopy(raw)
    _validate_v2(normalized)
    return normalized


def compile_workflows(raw: dict, assets_dir: pathlib.Path | None = None) -> dict[str, str]:
    config = normalize_config(raw)
    from workflow_compiler import compile_workflows as compile_canonical_workflows

    return compile_canonical_workflows(config, assets_dir or MODULE_DIR / "assets")


def capabilities(config: dict, kind: str | None = None) -> list[dict]:
    items = config.get("capabilities", [])
    return [item for item in items if kind is None or item.get("kind") == kind]


def single_capability(config: dict, kind: str) -> dict:
    matches = capabilities(config, kind)
    if len(matches) != 1:
        raise ValueError(f"exactly one {kind} capability is required")
    return matches[0]


def capability_kinds(config: dict) -> set[str]:
    return {item["kind"] for item in capabilities(config)}


def application_environment_refs(config: dict, lane: str) -> dict[str, str]:
    if lane not in LANES:
        raise ValueError(f"application environment lane must be one of: {', '.join(LANES)}")
    application = single_capability(config, "coolify.application")
    refs = copy.deepcopy(application["bindings"][lane].get("environmentVariableRefs", {}))
    for capability in capabilities(config):
        binding = capability["bindings"][lane]
        variable = binding.get("applicationVariable")
        credential = binding.get("credentialRef")
        if variable is None and credential is None:
            continue
        if not isinstance(variable, str) or not variable or not isinstance(credential, str) or not credential:
            raise ValueError(f"capability {capability['id']} has an invalid application credential binding")
        if variable in refs and refs[variable] != credential:
            raise ValueError(f"conflicting credential refs for application variable {variable} in {lane}")
        refs[variable] = credential
    return refs


def _migrate_v1(raw: dict) -> dict:
    migrated = copy.deepcopy(raw)
    project = migrated.setdefault("project", {})
    stack = project.pop("stack", None)
    if stack not in {"nest-postgres", "convex", "hybrid"}:
        raise ValueError("schema v1 project.stack must be nest-postgres, convex, or hybrid")
    commands = migrated.get("commands", {})
    coolify = migrated.get("coolify", {})
    coolify.setdefault("apiPolicy", _default_coolify_api_policy())
    deployment = migrated.setdefault("deployment", {})
    deployment.setdefault("minimumCoolifyVersion", "4.1.2")
    deployment.setdefault("revisionStrategy", "git-commit-sha")
    service_root = project.get("serviceRoot", ".")
    required_legacy_commands = []
    if stack in {"nest-postgres", "hybrid"}:
        required_legacy_commands.extend(("migrateCheck", "migrateStage", "migrateProduction"))
    if stack in {"convex", "hybrid"}:
        required_legacy_commands.extend(("backendCheck", "deployStage", "deployProduction"))
    for key in required_legacy_commands:
        if not isinstance(commands.get(key), str) or not commands[key]:
            raise ValueError(f"commands.{key} is required by schema v1 project.stack={stack}")

    application = {
        "id": "application",
        "kind": "coolify.application",
        "root": service_root,
        "detection": {"deploymentContracts": ["Dockerfile", "docker-compose.yml", "compose.yml", "nixpacks.toml"]},
        "commands": {},
        "bindings": {
            lane: {
                "environment": coolify.get(lane, {}).get("environment", lane),
                "resourceRef": coolify.get(lane, {}).get("applicationUuid"),
                "domain": coolify.get(lane, {}).get("domain"),
                "environmentVariableRefs": copy.deepcopy(
                    coolify.get(lane, {}).get("environmentVariableRefs", {})
                ),
            }
            for lane in LANES
        },
        "workflow": {"stageGate": "deploy-stage", "productionGate": "deploy-production"},
        "evidence": {"claims": ["repo-ready", "stage-healthy", "production-configured"]},
    }
    result = [application]
    if stack in {"nest-postgres", "hybrid"}:
        result.append({
            "id": "postgres",
            "kind": "coolify.postgresql",
            "root": service_root,
            "detection": {"packageMarkers": ["pg", "postgres", "typeorm", "prisma"]},
            "commands": {
                "check": commands.get("migrateCheck"),
                "deployStage": commands.get("migrateStage"),
                "deployProduction": commands.get("migrateProduction"),
            },
            "bindings": {
                lane: {
                    "environment": coolify.get(lane, {}).get("environment", lane),
                    "provider": coolify.get(lane, {}).get("dataBackendProvider"),
                    "resourceRef": coolify.get(lane, {}).get("dataBackendRef"),
                    "credentialRef": application["bindings"][lane]["environmentVariableRefs"].get("DATABASE_URL"),
                    "applicationVariable": "DATABASE_URL",
                    "workflowSecretName": "DATABASE_URL",
                }
                for lane in LANES
            },
            "workflow": {"stageGate": "migration-stage", "productionGate": "migration-production"},
            "evidence": {"claims": ["postgres-stage-bound", "postgres-production-bound"]},
        })
    if stack in {"convex", "hybrid"}:
        result.append({
            "id": "convex",
            "kind": "convex.deployment",
            "root": service_root,
            "detection": {"packageMarkers": ["convex"], "directories": ["convex"]},
            "commands": {
                "check": commands.get("backendCheck"),
                "deployStage": commands.get("deployStage"),
                "deployProduction": commands.get("deployProduction"),
            },
            "bindings": {
                lane: {
                    "environment": coolify.get(lane, {}).get("environment", lane),
                    "provider": "convex",
                    "projectRef": None,
                    "resourceRef": coolify.get(lane, {}).get("dataBackendRef"),
                    "deploymentType": "permanent",
                    "deployKeyRef": (
                        "STAGE_CONVEX_DEPLOY_KEY" if lane == "stage" else "PRODUCTION_CONVEX_DEPLOY_KEY"
                    ),
                    "workflowSecretName": "CONVEX_DEPLOY_KEY",
                }
                for lane in LANES
            },
            "workflow": {"stageGate": "backend-stage", "productionGate": "backend-production"},
            "evidence": {"claims": ["convex-stage-bound", "convex-production-bound"]},
        })
    migrated["schemaVersion"] = 2
    migrated["capabilities"] = result
    migrated["commands"] = {
        key: commands[key]
        for key in ("install", "test", "lint", "typecheck", "build", "smoke")
        if key in commands
    }
    coolify.pop("stage", None)
    coolify.pop("production", None)
    migrated.setdefault("deliveryPolicy", _default_delivery_policy())
    migrated["migration"] = {"sourceSchemaVersion": 1, "stackAlias": stack}
    return migrated


def _validate_v2(config: dict) -> None:
    project = config.get("project")
    if not isinstance(project, dict):
        raise ValueError("project must be an object")
    deployment = config.get("deployment")
    if not isinstance(deployment, dict):
        raise ValueError("deployment must be an object")
    validate_repository_contract(config)
    if deployment.get("minimumCoolifyVersion") != "4.1.2":
        raise ValueError("deployment.minimumCoolifyVersion must be 4.1.2")
    if deployment.get("revisionStrategy") != "git-commit-sha":
        raise ValueError("deployment.revisionStrategy must be git-commit-sha")
    commands = config.get("commands")
    if not isinstance(commands, dict):
        raise ValueError("commands must be an object")
    for key in ("install", "test", "lint", "typecheck", "build", "smoke"):
        _validate_command(commands.get(key), f"commands.{key}")
    items = config.get("capabilities")
    if not isinstance(items, list) or not items:
        raise ValueError("schema v2 capabilities must be a non-empty list")
    seen = set()
    kind_counts: dict[str, int] = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("capability entries must be objects")
        capability_id = item.get("id")
        kind = item.get("kind")
        if not isinstance(capability_id, str) or not CAPABILITY_ID.fullmatch(capability_id):
            raise ValueError("capability.id must be a lowercase stable identifier")
        if capability_id in seen:
            raise ValueError(f"duplicate capability id: {capability_id}")
        seen.add(capability_id)
        if not isinstance(kind, str) or not CAPABILITY_KIND.fullmatch(kind):
            raise ValueError(f"capability {capability_id} has an invalid kind")
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        root = item.get("root")
        if not isinstance(root, str) or not root:
            raise ValueError(f"capability {capability_id}.root must be a non-empty path")
        for field in ("detection", "commands", "bindings", "workflow", "evidence"):
            if not isinstance(item.get(field), dict):
                raise ValueError(f"capability {capability_id}.{field} must be an object")
        bindings = item["bindings"]
        if set(bindings) != set(LANES):
            raise ValueError(f"capability {capability_id} must bind exactly stage and production")
        if any(not isinstance(bindings[lane], dict) for lane in LANES):
            raise ValueError(f"capability {capability_id} lane bindings must be objects")
        workflow = item["workflow"]
        if any(
            not isinstance(workflow.get(key), str) or not WORKFLOW_GATE.fullmatch(workflow[key])
            for key in ("stageGate", "productionGate")
        ):
            raise ValueError(f"capability {capability_id} workflow must define literal stageGate and productionGate")
        claims = item["evidence"].get("claims")
        if not isinstance(claims, list) or not claims or any(not isinstance(claim, str) or not claim for claim in claims):
            raise ValueError(f"capability {capability_id} evidence.claims must be a non-empty string list")

        if kind == "coolify.application":
            _validate_application(item)
        elif kind == "coolify.postgresql":
            _validate_postgres(item)
        elif kind == "convex.deployment":
            _validate_convex(item)

    if kind_counts.get("coolify.application") != 1:
        raise ValueError("schema v2 requires exactly one coolify.application capability")
    for kind in ("coolify.postgresql", "convex.deployment"):
        if kind_counts.get(kind, 0) > 1:
            raise ValueError(f"schema v2 supports at most one {kind} capability")
    _validate_delivery_policy(config)
    if config.get("coolify", {}).get("apiPolicy") != _default_coolify_api_policy():
        raise ValueError("coolify.apiPolicy must use the reviewed fail-closed transport and token policy")
    stage_credentials = set(application_environment_refs(config, "stage").values())
    production_credentials = set(application_environment_refs(config, "production").values())
    if stage_credentials.intersection(production_credentials):
        raise ValueError("Application stage and production credential refs must be distinct")


def _required_commands(item: dict, label: str) -> None:
    commands = item["commands"]
    keys = ("check", "deployStage", "deployProduction")
    if any(not isinstance(commands.get(key), str) or not commands[key] for key in keys):
        raise ValueError(f"{label} commands must define check, deployStage, and deployProduction")
    for key in keys:
        _validate_command(commands[key], f"{label} commands.{key}")


def _validate_command(command: object, label: str) -> None:
    if (
        not isinstance(command, str)
        or not command.strip()
        or len(command) > 1000
        or any(character in command for character in ("\n", "\r", "\0"))
    ):
        raise ValueError(f"{label} must be a bounded single-line command")


def _validate_lane_environment(item: dict) -> None:
    for lane in LANES:
        if item["bindings"][lane].get("environment") != lane:
            raise ValueError(f"capability {item['id']} bindings.{lane}.environment must be {lane}")


def _optional_string(binding: dict, key: str, label: str) -> None:
    value = binding.get(key)
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"{label}.{key} must be null or a non-empty string")


def _validate_application(item: dict) -> None:
    _validate_lane_environment(item)
    for lane in LANES:
        binding = item["bindings"][lane]
        for key in ("resourceRef", "domain"):
            _optional_string(binding, key, f"application bindings.{lane}")
        refs = binding.get("environmentVariableRefs")
        if not isinstance(refs, dict) or any(
            not isinstance(key, str) or not key or not isinstance(value, str) or not value
            for key, value in refs.items()
        ):
            raise ValueError(f"application bindings.{lane}.environmentVariableRefs must map names to refs")
    _require_distinct_if_configured(item, "resourceRef", "Application")
    _require_distinct_if_configured(item, "domain", "Application")


def _validate_postgres(item: dict) -> None:
    _required_commands(item, "postgres")
    _validate_lane_environment(item)
    for lane in LANES:
        binding = item["bindings"][lane]
        if binding.get("provider") != "coolify-postgresql":
            raise ValueError(f"postgres bindings.{lane}.provider must be coolify-postgresql")
        _optional_string(binding, "resourceRef", f"postgres bindings.{lane}")
        credential_ref = binding.get("credentialRef")
        if not isinstance(credential_ref, str) or not credential_ref:
            raise ValueError(f"postgres bindings.{lane}.credentialRef must be a non-empty reference")
        if binding.get("applicationVariable") != "DATABASE_URL":
            raise ValueError(f"postgres bindings.{lane}.applicationVariable must be DATABASE_URL")
        if binding.get("workflowSecretName") != "DATABASE_URL":
            raise ValueError(f"postgres bindings.{lane}.workflowSecretName must be DATABASE_URL")
    _require_distinct_if_configured(item, "resourceRef", "PostgreSQL")
    _require_distinct(item, "credentialRef", "PostgreSQL")


def _validate_convex(item: dict) -> None:
    _required_commands(item, "convex")
    _validate_lane_environment(item)
    for lane in LANES:
        binding = item["bindings"][lane]
        if binding.get("provider") != "convex":
            raise ValueError(f"convex bindings.{lane}.provider must be convex")
        if binding.get("deploymentType") != "permanent":
            raise ValueError(f"convex bindings.{lane}.deploymentType must be permanent")
        for key in ("projectRef", "resourceRef"):
            if key not in binding:
                raise ValueError(f"convex bindings.{lane}.{key} is required")
            _optional_string(binding, key, f"convex bindings.{lane}")
        deploy_key_ref = binding.get("deployKeyRef")
        if not isinstance(deploy_key_ref, str) or not deploy_key_ref:
            raise ValueError(f"convex bindings.{lane}.deployKeyRef must be a non-empty reference")
        if binding.get("workflowSecretName") != "CONVEX_DEPLOY_KEY":
            raise ValueError(f"convex bindings.{lane}.workflowSecretName must be CONVEX_DEPLOY_KEY")
    _require_distinct_if_configured(item, "projectRef", "Convex")
    _require_distinct_if_configured(item, "resourceRef", "Convex")
    _require_distinct(item, "deployKeyRef", "Convex")


def _require_distinct_if_configured(item: dict, key: str, label: str) -> None:
    values = [item["bindings"][lane].get(key) for lane in LANES]
    if all(value is not None for value in values) and values[0] == values[1]:
        raise ValueError(f"{label} stage and production {key} values must be distinct")


def _require_distinct(item: dict, key: str, label: str) -> None:
    values = [item["bindings"][lane].get(key) for lane in LANES]
    if any(not isinstance(value, str) or not value for value in values) or values[0] == values[1]:
        raise ValueError(f"{label} stage and production {key} values must be distinct")


def _default_delivery_policy() -> dict:
    return {
        "production": {
            "githubEnvironment": "production",
            "manualDispatchOnly": True,
            "requiredReviewers": 1,
            "preventSelfReview": True,
        },
        "rollback": {
            "strategy": "redeploy-previous-verified-revision",
            "requiresProductionApproval": True,
            "recordPreviousRevision": True,
        },
    }


def _default_coolify_api_policy() -> dict:
    return {
        "httpsRequired": True,
        "redirects": "deny",
        "ambientProxy": False,
        "timeoutSeconds": 30,
        "maxResponseBytes": 1048576,
        "tokenMaxTtlHours": 24,
        "ipAllowlistRequired": True,
        "splitPinAndDeployCredentials": True,
    }


def _validate_delivery_policy(config: dict) -> None:
    policy = config.get("deliveryPolicy")
    if not isinstance(policy, dict):
        raise ValueError("deliveryPolicy must be an object")
    production = policy.get("production")
    rollback = policy.get("rollback")
    if not isinstance(production, dict) or not isinstance(rollback, dict):
        raise ValueError("deliveryPolicy must define production and rollback objects")
    expected_production = {
        "githubEnvironment": "production",
        "manualDispatchOnly": True,
        "preventSelfReview": True,
    }
    if any(production.get(key) != value for key, value in expected_production.items()):
        raise ValueError("deliveryPolicy.production must require manual protected production approval")
    reviewers = production.get("requiredReviewers")
    if not isinstance(reviewers, int) or isinstance(reviewers, bool) or reviewers < 1:
        raise ValueError("deliveryPolicy.production.requiredReviewers must be at least 1")
    if rollback != {
        "strategy": "redeploy-previous-verified-revision",
        "requiresProductionApproval": True,
        "recordPreviousRevision": True,
    }:
        raise ValueError("deliveryPolicy.rollback must redeploy a recorded verified revision through production approval")
