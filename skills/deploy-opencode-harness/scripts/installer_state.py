"""Provider-neutral capability and private installer-state primitives."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import re
import tempfile
from collections.abc import Iterable, Mapping


REQUIRED_CAPABILITY_OUTCOMES = (
    "bounded-command",
    "deployment-definition",
    "persistence",
    "secret-storage",
    "service-reconcile-lifecycle",
    "https-route",
    "private-harness-probe",
    "status-diagnostics",
)

PHASES = (
    "preflight",
    "awaiting-github-app",
    "github-app-verified",
    "branches-verified",
    "awaiting-ruleset-authority",
    "rulesets-verified",
    "branch-policy-resolved",
    "deployed",
    "verified",
    "reported",
)

BRANCH_POLICY_MODES = (
    "protected-rulesets",
    "unprotected-degraded",
)

DEGRADED_BRANCH_POLICY_ERROR_CODES = (
    "rulesets_feature_unavailable_private_plan",
)

_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_OPAQUE_SECRET_REF = re.compile(
    r"^(?:secret|vault|keyring|provider-secret|env|file-ref|opaque)://[^\s]+$"
)
_STATE_FIELDS = {
    "schema_version",
    "repository",
    "repository_hash",
    "environment",
    "harness_identity",
    "phase",
    "secret_refs",
    "metadata",
}
_METADATA_FIELDS = {
    "completed_operations",
    "created_at",
    "desired_state_digest",
    "github_app_id",
    "github_app_installation_id",
    "branch_policy_mode",
    "last_error_code",
    "public_url",
    "updated_at",
}
_SENSITIVE_FIELD_PARTS = {
    "credential",
    "credentials",
    "password",
    "passwd",
    "pem",
    "secret",
    "token",
}
_SENSITIVE_FIELD_SUFFIXES = ("api_key", "private_key")


class CapabilityError(ValueError):
    """Base error for invalid or insufficient capability observations."""


class MissingCapabilitiesError(CapabilityError):
    """Raised when required provider-neutral outcomes are unavailable."""

    def __init__(self, missing: Iterable[str]):
        self.missing = tuple(missing)
        super().__init__("missing required capabilities: " + ", ".join(self.missing))


class SecretStateError(ValueError):
    """Raised when persisted installer state could contain a secret value."""


def _normalize_outcome(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CapabilityError("capability outcome must be a non-empty string")
    outcome = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    aliases = {
        "one-https-route": "https-route",
        "service-reconcile": "service-reconcile-lifecycle",
        "service-lifecycle": "service-reconcile-lifecycle",
        "service-reconcile-lifecycle": "service-reconcile-lifecycle",
    }
    return aliases.get(outcome, outcome)


def normalize_capabilities(observed: object) -> dict[str, object]:
    """Bind required semantic outcomes to opaque provider capability handles."""
    entries: list[tuple[object, object]] = []
    if isinstance(observed, Mapping):
        entries.extend(observed.items())
    elif isinstance(observed, Iterable) and not isinstance(observed, (str, bytes)):
        for item in observed:
            if not isinstance(item, Mapping):
                raise CapabilityError("each capability must be an object")
            if "outcome" not in item:
                raise CapabilityError("capability is missing outcome")
            handle = item.get("handle", item.get("capability"))
            entries.append((item["outcome"], handle))
    else:
        raise CapabilityError("capabilities must be a mapping or iterable")

    normalized: dict[str, object] = {}
    for raw_outcome, handle in entries:
        outcome = _normalize_outcome(raw_outcome)
        if outcome not in REQUIRED_CAPABILITY_OUTCOMES:
            continue
        if handle is None:
            continue
        if outcome in normalized and normalized[outcome] != handle:
            raise CapabilityError(f"multiple capabilities provide outcome {outcome}")
        normalized[outcome] = handle

    missing = tuple(
        outcome
        for outcome in REQUIRED_CAPABILITY_OUTCOMES
        if outcome not in normalized
    )
    if missing:
        raise MissingCapabilitiesError(missing)
    return {outcome: normalized[outcome] for outcome in REQUIRED_CAPABILITY_OUTCOMES}


def canonical_repository(repository: object) -> str:
    if not isinstance(repository, str) or not _REPOSITORY.fullmatch(repository.strip()):
        raise ValueError("repository must be an owner/repository coordinate")
    return repository.strip().lower()


def repository_hash(repository: object) -> str:
    coordinate = canonical_repository(repository)
    return hashlib.sha256(coordinate.encode("utf-8")).hexdigest()


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "repository"


def harness_identity(repository: object) -> str:
    coordinate = canonical_repository(repository)
    owner, name = coordinate.split("/", 1)
    return f"harness-{_slug(owner)}-{_slug(name)}-{repository_hash(coordinate)[:8]}"


def classify_resource_action(
    repository: object,
    environment: object,
    observed_resources: Iterable[Mapping[str, object]],
) -> str:
    """Classify a deterministic Harness as create, reconcile, or collision."""
    coordinate = canonical_repository(repository)
    if not isinstance(environment, str) or not environment:
        raise ValueError("environment must be a non-empty string")
    identity = harness_identity(coordinate)
    candidates = []
    for resource in observed_resources:
        if not isinstance(resource, Mapping):
            raise ValueError("observed resource must be an object")
        raw_repository = resource.get("repository")
        same_repository = False
        if isinstance(raw_repository, str):
            try:
                same_repository = canonical_repository(raw_repository) == coordinate
            except ValueError:
                same_repository = False
        if resource.get("identity") == identity or same_repository:
            candidates.append(resource)

    if not candidates:
        return "create"
    if len(candidates) != 1:
        return "collision"

    resource = candidates[0]
    try:
        compatible_repository = canonical_repository(resource.get("repository"))
    except ValueError:
        return "collision"
    if (
        resource.get("identity") == identity
        and compatible_repository == coordinate
        and resource.get("environment") == environment
    ):
        return "reconcile"
    return "collision"


def _is_sensitive_field(field: object) -> bool:
    if not isinstance(field, str):
        return False
    normalized = re.sub(r"[^a-z0-9]+", "_", field.lower()).strip("_")
    parts = set(normalized.split("_"))
    return bool(parts & _SENSITIVE_FIELD_PARTS) or normalized.endswith(
        _SENSITIVE_FIELD_SUFFIXES
    )


def redact_sensitive(value: object) -> object:
    """Return a copy suitable for diagnostics without secret-bearing values."""
    if isinstance(value, Mapping):
        redacted = {}
        for key, item in value.items():
            if _is_sensitive_field(key) and key != "secret_refs":
                redacted[key] = "[REDACTED]"
            elif key == "secret_refs":
                redacted[key] = {
                    ref_name: "[OPAQUE SECRET REF]"
                    for ref_name in item
                } if isinstance(item, Mapping) else "[REDACTED]"
            else:
                redacted[key] = redact_sensitive(item)
        return redacted
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_sensitive(item) for item in value)
    return value


def new_state(
    repository: object,
    environment: object,
    *,
    secret_refs: Mapping[str, str] | None = None,
    metadata: Mapping[str, object] | None = None,
) -> dict[str, object]:
    coordinate = canonical_repository(repository)
    if not isinstance(environment, str) or not environment:
        raise ValueError("environment must be a non-empty string")
    state = {
        "schema_version": 1,
        "repository": coordinate,
        "repository_hash": repository_hash(coordinate),
        "environment": environment,
        "harness_identity": harness_identity(coordinate),
        "phase": "preflight",
        "secret_refs": dict(secret_refs or {}),
        "metadata": copy.deepcopy(dict(metadata or {})),
    }
    validate_state(state)
    return state


def _raise_if_secret_field(value: object, context: str) -> None:
    if isinstance(value, Mapping):
        for field, item in value.items():
            if _is_sensitive_field(field):
                raise SecretStateError(
                    f"secret field {field!r} is not allowed in {context}"
                )
            _raise_if_secret_field(item, f"{context}.{field}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _raise_if_secret_field(item, f"{context}[{index}]")


def validate_state(state: object) -> None:
    if not isinstance(state, dict):
        raise ValueError("installer state must be a JSON object")
    _raise_if_secret_field(
        {key: value for key, value in state.items() if key != "secret_refs"},
        "installer state",
    )
    unexpected = set(state) - _STATE_FIELDS
    missing = _STATE_FIELDS - set(state)
    if unexpected:
        raise ValueError("unexpected installer state fields: " + ", ".join(sorted(unexpected)))
    if missing:
        raise ValueError("missing installer state fields: " + ", ".join(sorted(missing)))
    if state["schema_version"] != 1 or type(state["schema_version"]) is not int:
        raise ValueError("schema_version must be the integer 1")

    coordinate = canonical_repository(state["repository"])
    if state["repository"] != coordinate:
        raise ValueError("repository must be canonical")
    if state["repository_hash"] != repository_hash(coordinate):
        raise ValueError("repository_hash does not match repository")
    if state["harness_identity"] != harness_identity(coordinate):
        raise ValueError("harness_identity does not match repository")
    if not isinstance(state["environment"], str) or not state["environment"]:
        raise ValueError("environment must be a non-empty string")
    if state["phase"] not in PHASES:
        raise ValueError("unknown installer phase")

    secret_refs = state["secret_refs"]
    if not isinstance(secret_refs, dict):
        raise SecretStateError("secret_refs must contain opaque secret references")
    for name, reference in secret_refs.items():
        if not isinstance(name, str) or not name:
            raise SecretStateError("secret reference names must be non-empty strings")
        if not isinstance(reference, str) or not _OPAQUE_SECRET_REF.fullmatch(reference):
            raise SecretStateError(
                f"secret_refs[{name!r}] must be an opaque secret reference"
            )

    metadata = state["metadata"]
    if not isinstance(metadata, dict):
        raise ValueError("metadata must be an object")
    _raise_if_secret_field(metadata, "metadata")
    unexpected_metadata = set(metadata) - _METADATA_FIELDS
    if unexpected_metadata:
        raise ValueError(
            "unexpected metadata fields: " + ", ".join(sorted(unexpected_metadata))
        )
    branch_policy_mode = metadata.get("branch_policy_mode")
    if branch_policy_mode is not None and branch_policy_mode not in BRANCH_POLICY_MODES:
        raise ValueError("unknown branch policy mode")
    try:
        json.dumps(state, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("installer state must contain JSON values") from error


def advance_phase(state: dict[str, object], target_phase: str) -> dict[str, object]:
    validate_state(state)
    if target_phase not in PHASES:
        raise ValueError(f"unknown installer phase {target_phase!r}")
    current_index = PHASES.index(state["phase"])
    target_index = PHASES.index(target_phase)
    if target_index < current_index:
        raise ValueError(
            f"phase regression from {state['phase']!r} to {target_phase!r} is not allowed"
        )
    if target_index == current_index:
        return state
    if (
        target_index >= PHASES.index("deployed")
        and state["metadata"].get("branch_policy_mode") not in BRANCH_POLICY_MODES
    ):
        raise ValueError("branch policy must be resolved before deployment")
    advanced = copy.deepcopy(state)
    advanced["phase"] = target_phase
    validate_state(advanced)
    return advanced


def resolve_branch_policy(
    state: dict[str, object],
    mode: str,
) -> dict[str, object]:
    """Record the enforced or explicitly degraded branch-integrity posture."""
    validate_state(state)
    if mode not in BRANCH_POLICY_MODES:
        raise ValueError(f"unknown branch policy mode {mode!r}")

    phase = state["phase"]
    if mode == "protected-rulesets":
        if phase != "rulesets-verified":
            raise ValueError("protected branch policy requires verified rulesets")
    else:
        error_code = state["metadata"].get("last_error_code")
        if error_code not in DEGRADED_BRANCH_POLICY_ERROR_CODES:
            raise ValueError(
                "unprotected degraded mode requires a proven private-plan limitation"
            )
        if phase not in {"branches-verified", "awaiting-ruleset-authority"}:
            raise ValueError(
                "unprotected degraded mode requires verified branches and unavailable rulesets"
            )

    resolved = copy.deepcopy(state)
    resolved["metadata"]["branch_policy_mode"] = mode
    resolved["phase"] = "branch-policy-resolved"
    validate_state(resolved)
    return resolved


def state_path(root: os.PathLike[str] | str, repository: object) -> pathlib.Path:
    return pathlib.Path(root) / f"{repository_hash(repository)}.json"


def _serialized_state(state: dict[str, object]) -> bytes:
    validate_state(state)
    return (json.dumps(state, indent=2, sort_keys=True, allow_nan=False) + "\n").encode(
        "utf-8"
    )


def save_state(
    root: os.PathLike[str] | str,
    state: dict[str, object],
) -> pathlib.Path:
    payload = _serialized_state(state)
    root_path = pathlib.Path(root)
    root_path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root_path, 0o700)
    path = state_path(root_path, state["repository"])

    try:
        if path.read_bytes() == payload:
            os.chmod(path, 0o600)
            return path
    except FileNotFoundError:
        pass

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=root_path
    )
    temporary_path = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
        directory_descriptor = os.open(root_path, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise
    return path


def load_state(
    root: os.PathLike[str] | str,
    repository: object,
) -> dict[str, object] | None:
    path = state_path(root, repository)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    validate_state(payload)
    if payload["repository_hash"] != repository_hash(repository):
        raise ValueError("state file repository does not match requested repository")
    return copy.deepcopy(payload)
