"""Load the standalone Issue Harness repository configuration."""

from __future__ import annotations

import copy
import json
import pathlib
import re


GITHUB_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def load_config(root: pathlib.Path) -> tuple[pathlib.Path, dict]:
    path = root / ".harness" / "config.json"
    config = json.loads(path.read_text())
    validate_config(config)
    return path, copy.deepcopy(config)


def validate_config(config: object) -> None:
    if not isinstance(config, dict):
        raise ValueError("harness config must be a JSON object")
    if type(config.get("schemaVersion")) is not int or config["schemaVersion"] != 1:
        raise ValueError("schemaVersion must be the integer 1")

    project = config.get("project")
    if not isinstance(project, dict):
        raise ValueError("project must be an object")
    repository = project.get("github")
    if not isinstance(repository, str) or not GITHUB_REPOSITORY.fullmatch(repository):
        raise ValueError("project.github must be an owner/repository coordinate")

    if not isinstance(config.get("issueAgent"), dict):
        raise ValueError("issueAgent must be an object")
