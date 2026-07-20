"""Standalone repository-level harness configuration contract."""

from __future__ import annotations

import pathlib
import re


PROJECT_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
GITHUB_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RUNNER_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
LANES = ("stage", "production")
V1_STACKS = {"nest-postgres", "convex", "hybrid"}


def validate_schema_header(raw: object) -> int:
    if not isinstance(raw, dict):
        raise ValueError("harness config must be a JSON object")
    version = raw.get("schemaVersion")
    if type(version) is not int or version not in (1, 2):
        raise ValueError("schemaVersion must be the integer 1 or 2")
    stack = raw.get("project", {}).get("stack")
    if version == 1 and stack not in V1_STACKS:
        raise ValueError("schema v1 project.stack must be nest-postgres, convex, or hybrid")
    if version == 2 and stack is not None:
        raise ValueError("project.stack is only supported as a schema v1 compatibility alias")
    return version


def validate_repository_contract(config: dict) -> None:
    project = config.get("project")
    if not isinstance(project, dict):
        raise ValueError("project must be an object")
    if not isinstance(project.get("slug"), str) or not PROJECT_SLUG.fullmatch(project["slug"]):
        raise ValueError("project.slug must be a stable lowercase slug")
    if not isinstance(project.get("github"), str) or not GITHUB_REPOSITORY.fullmatch(project["github"]):
        raise ValueError("project.github must be an owner/repository coordinate")
    service_root = project.get("serviceRoot")
    if (
        not isinstance(service_root, str)
        or not service_root
        or pathlib.PurePosixPath(service_root).is_absolute()
        or ".." in pathlib.PurePosixPath(service_root).parts
    ):
        raise ValueError("project.serviceRoot must be a bounded relative repository path")

    branches = config.get("branches")
    expected_branches = {"stage": "stage", "production": "main", "agentPrBase": "stage"}
    if not isinstance(branches, dict) or set(branches) != set(expected_branches):
        raise ValueError("branches must define exactly stage, production, and agentPrBase")
    for key, expected in expected_branches.items():
        if branches.get(key) != expected:
            raise ValueError(f"branches.{key} must be {expected!r}")

    runtime = config.get("runtime")
    if not isinstance(runtime, dict):
        raise ValueError("runtime must be an object")
    port = runtime.get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("runtime.port must be an integer from 1 to 65535")
    health_path = runtime.get("healthPath")
    if (
        not isinstance(health_path, str)
        or not health_path.startswith("/")
        or len(health_path) > 256
        or any(character.isspace() for character in health_path)
        or any(character in health_path for character in ("?", "#", "\0"))
    ):
        raise ValueError("runtime.healthPath must be a bounded absolute URL path")

    deployment = config.get("deployment")
    if not isinstance(deployment, dict):
        raise ValueError("deployment must be an object")
    if deployment.get("sourceVisibility") not in {"private", "public"}:
        raise ValueError("deployment.sourceVisibility must be private or public")
    if not isinstance(deployment.get("buildPack"), str) or not deployment["buildPack"]:
        raise ValueError("deployment.buildPack must be a non-empty literal")
    if not isinstance(deployment.get("dockerfile"), str) or not deployment["dockerfile"]:
        raise ValueError("deployment.dockerfile must be a non-empty relative path")
    runners = deployment.get("gateRunners")
    if not isinstance(runners, dict) or set(runners) != set(LANES):
        raise ValueError("deployment.gateRunners must define exactly stage and production")
    for lane in LANES:
        if not isinstance(runners[lane], str) or not RUNNER_LABEL.fullmatch(runners[lane]):
            raise ValueError(
                f"deployment.gateRunners.{lane} must be a literal reviewed runner label"
            )
