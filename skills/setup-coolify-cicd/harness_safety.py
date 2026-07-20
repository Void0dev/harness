"""Strict deployment identifiers and repository-relative path validation."""

from __future__ import annotations

import pathlib
import re
import urllib.parse


LITERAL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
KNOWN_CAPABILITY_KINDS = frozenset({"coolify.application", "coolify.postgresql", "convex.deployment"})


def validate_literal_id(value: object, label: str, *, optional: bool = False) -> None:
    if optional and value is None:
        return
    if not isinstance(value, str) or not LITERAL_ID.fullmatch(value):
        raise ValueError(f"{label} must be a bounded literal identifier")


def validate_relative_posix_path(value: object, label: str, *, allow_dot: bool = True) -> None:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError(f"{label} must be a bounded relative POSIX path")
    if "\\" in value or "%" in value or urllib.parse.unquote(value) != value or "//" in value:
        raise ValueError(f"{label} must not contain encoded, backslash, or empty segments")
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or value.startswith("/") or value.endswith("/"):
        raise ValueError(f"{label} must be a relative POSIX path")
    if value == "." and allow_dot:
        return
    if not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"{label} must not contain dot segments")


def validate_harness_safety(config: dict) -> None:
    project = config.get("project", {})
    deployment = config.get("deployment", {})
    validate_relative_posix_path(project.get("serviceRoot"), "project.serviceRoot")
    validate_relative_posix_path(deployment.get("dockerfile"), "deployment.dockerfile", allow_dot=False)
    if deployment.get("composeFile") is not None:
        validate_relative_posix_path(deployment.get("composeFile"), "deployment.composeFile", allow_dot=False)
    coolify = config.get("coolify", {})
    for key in ("projectUuid", "serverUuid", "githubAppUuid"):
        validate_literal_id(coolify.get(key), f"coolify.{key}", optional=True)
    issue_agent = config.get("issueAgent", {})
    if isinstance(issue_agent, dict):
        for key in ("applicationUuid", "serverUuid"):
            validate_literal_id(issue_agent.get(key), f"issueAgent.{key}", optional=True)
    for capability in config.get("capabilities", []):
        if not isinstance(capability, dict):
            continue
        capability_id = str(capability.get("id", "unknown"))
        if capability.get("kind") not in KNOWN_CAPABILITY_KINDS:
            raise ValueError(
                f"capability {capability_id} has no registered compiler/verifier"
            )
        validate_relative_posix_path(capability.get("root"), f"capability {capability_id}.root")
        for lane, binding in capability.get("bindings", {}).items():
            if not isinstance(binding, dict):
                continue
            validate_literal_id(
                binding.get("resourceRef"),
                f"capability {capability_id} bindings.{lane}.resourceRef",
                optional=True,
            )
            if capability.get("kind") == "convex.deployment":
                validate_literal_id(
                    binding.get("projectRef"),
                    f"capability {capability_id} bindings.{lane}.projectRef",
                    optional=True,
                )
