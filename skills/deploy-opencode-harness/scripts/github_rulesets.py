#!/usr/bin/env python3
"""Plan, apply, and verify the Harness-owned GitHub repository rulesets."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


MANAGED_RULESETS = (
    ("harness-stage", "refs/heads/stage"),
    ("harness-production", "refs/heads/main"),
)

PULL_REQUEST_PARAMETERS = {
    "dismiss_stale_reviews_on_push": False,
    "require_code_owner_review": False,
    "require_last_push_approval": False,
    "required_approving_review_count": 0,
    "required_review_thread_resolution": False,
}

PRODUCTION_WORKFLOW_POLICY = {
    "production_pull_request_head_ref": "refs/heads/stage",
}


class RulesetError(RuntimeError):
    """Base error for deterministic ruleset reconciliation failures."""


class RulesetApiError(RulesetError):
    """An API operation failed without exposing provider error text or secrets."""


class VerificationError(RulesetError):
    """The bootstrap-authority read-back did not match the intended state."""


def _api_call(operation: str, function, *args):
    try:
        return function(*args)
    except Exception:
        raise RulesetApiError(f"GitHub ruleset API {operation} failed") from None


def _validate_status_checks(required_status_checks: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    checks = []
    seen = set()
    for raw_check in required_status_checks:
        check = dict(raw_check)
        unsupported = set(check) - {"context", "integration_id"}
        if unsupported:
            raise ValueError(f"unsupported required status check fields: {sorted(unsupported)}")
        context = check.get("context")
        if not isinstance(context, str) or not context.strip():
            raise ValueError("required status check context must be a non-empty string")
        normalized = {"context": context}
        if "integration_id" in check:
            integration_id = check["integration_id"]
            if isinstance(integration_id, bool) or not isinstance(integration_id, int):
                raise ValueError("required status check integration_id must be an integer")
            normalized["integration_id"] = integration_id
        identity = (normalized["context"], normalized.get("integration_id"))
        if identity in seen:
            raise ValueError(f"duplicate required status check: {context}")
        seen.add(identity)
        checks.append(normalized)
    return checks


def _actor_reference(raw_actor: Any, default_actor_type: str = "Integration") -> dict[str, Any]:
    if isinstance(raw_actor, bool):
        raise ValueError("bypass actor must not be boolean")
    if isinstance(raw_actor, int):
        return {"actor_type": default_actor_type, "actor_id": raw_actor}
    if isinstance(raw_actor, str) and raw_actor:
        return {"actor_type": default_actor_type, "actor": raw_actor}
    if isinstance(raw_actor, Mapping):
        actor = dict(raw_actor)
        if "actor_id" not in actor and "actor" not in actor:
            raise ValueError("bypass actor requires actor_id or actor")
        actor.setdefault("actor_type", default_actor_type)
        return actor
    raise ValueError("bypass actor must be an id, name, or mapping")


def _resolve_actor(api, repository: str, raw_actor: Any) -> dict[str, Any]:
    actor = _actor_reference(raw_actor)
    actor_type = actor["actor_type"]
    actor_id = actor.get("actor_id")
    if actor_id is None:
        actor_id = _api_call(
            "bypass actor resolution",
            api.resolve_bypass_actor,
            repository,
            actor_type,
            actor["actor"],
        )
    if isinstance(actor_id, bool) or not isinstance(actor_id, int):
        raise ValueError("resolved bypass actor id must be an integer")
    return {
        "actor_id": actor_id,
        "actor_type": actor_type,
        "bypass_mode": actor.get("bypass_mode", "pull_request"),
    }


def _resolved_bypass_actors(
    api,
    repository: str,
    release_app: Any,
    bypass_actors: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    release_reference = _actor_reference(release_app)
    if release_reference.get("bypass_mode", "pull_request") != "pull_request":
        raise ValueError("Release App bypass mode must be pull_request, never unrestricted")
    release_actor = _resolve_actor(api, repository, release_reference)
    release_actor["bypass_mode"] = "pull_request"
    actors = [release_actor]
    release_identity = (release_actor["actor_type"], release_actor["actor_id"])

    for raw_actor in bypass_actors:
        actor = _resolve_actor(api, repository, raw_actor)
        identity = (actor["actor_type"], actor["actor_id"])
        if identity == release_identity and actor["bypass_mode"] != "pull_request":
            raise ValueError("Release App bypass mode must be pull_request, never unrestricted")
        actors.append(actor)

    unique = {}
    for actor in actors:
        identity = (actor["actor_type"], actor["actor_id"])
        previous = unique.get(identity)
        if previous is not None and previous != actor:
            raise ValueError(f"conflicting bypass modes for actor id {actor['actor_id']}")
        unique[identity] = actor
    return sorted(unique.values(), key=lambda item: (item["actor_type"], item["actor_id"], item["bypass_mode"]))


def _rules(required_status_checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rules = [
        {"type": "deletion"},
        {"type": "non_fast_forward"},
        {"type": "pull_request", "parameters": dict(PULL_REQUEST_PARAMETERS)},
    ]
    if required_status_checks:
        rules.append({
            "type": "required_status_checks",
            "parameters": {
                "do_not_enforce_on_create": False,
                "required_status_checks": required_status_checks,
                "strict_required_status_checks_policy": True,
            },
        })
    return rules


def build_desired_rulesets(
    api,
    repository: str,
    *,
    required_status_checks: Iterable[Mapping[str, Any]],
    release_app: Any,
    bypass_actors: Iterable[Mapping[str, Any]] = (),
) -> dict[str, dict[str, Any]]:
    """Build the two Harness-owned rulesets from proven inputs only."""
    checks = _validate_status_checks(required_status_checks)
    actors = _resolved_bypass_actors(api, repository, release_app, bypass_actors)
    return {
        name: {
            "name": name,
            "target": "branch",
            "enforcement": "active",
            "bypass_actors": [dict(actor) for actor in actors],
            "conditions": {
                "ref_name": {"exclude": [], "include": [branch_ref]},
            },
            "rules": _rules([dict(check) for check in checks]),
        }
        for name, branch_ref in MANAGED_RULESETS
    }


def _canonical_status_checks(checks: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        (dict(check) for check in checks),
        key=lambda item: (item.get("context", ""), item.get("integration_id", -1)),
    )


def _canonical_rule(raw_rule: Mapping[str, Any]) -> dict[str, Any]:
    rule_type = raw_rule.get("type")
    rule = {"type": rule_type}
    parameters = raw_rule.get("parameters")
    if rule_type == "pull_request":
        parameters = parameters or {}
        rule["parameters"] = {
            key: parameters.get(key)
            for key in PULL_REQUEST_PARAMETERS
        }
    elif rule_type == "required_status_checks":
        parameters = parameters or {}
        rule["parameters"] = {
            "do_not_enforce_on_create": parameters.get("do_not_enforce_on_create", False),
            "required_status_checks": _canonical_status_checks(parameters.get("required_status_checks", ())),
            "strict_required_status_checks_policy": parameters.get("strict_required_status_checks_policy"),
        }
    elif parameters is not None:
        rule["parameters"] = parameters
    return rule


def normalize_ruleset(raw_ruleset: Mapping[str, Any]) -> dict[str, Any]:
    """Strip API-only fields and canonicalize semantically unordered collections."""
    conditions = raw_ruleset.get("conditions") or {}
    ref_name = conditions.get("ref_name") or {}
    actors = [
        {
            "actor_id": actor.get("actor_id"),
            "actor_type": actor.get("actor_type"),
            "bypass_mode": actor.get("bypass_mode"),
        }
        for actor in raw_ruleset.get("bypass_actors", ())
    ]
    rules = [_canonical_rule(item) for item in raw_ruleset.get("rules", ())]
    rule_order = {"deletion": 0, "non_fast_forward": 1, "pull_request": 2, "required_status_checks": 3}
    return {
        "name": raw_ruleset.get("name"),
        "target": raw_ruleset.get("target"),
        "enforcement": raw_ruleset.get("enforcement"),
        "bypass_actors": sorted(
            actors,
            key=lambda item: (item["actor_type"] or "", item["actor_id"] or -1, item["bypass_mode"] or ""),
        ),
        "conditions": {
            "ref_name": {
                "exclude": sorted(ref_name.get("exclude", ())),
                "include": sorted(ref_name.get("include", ())),
            },
        },
        "rules": sorted(rules, key=lambda item: (rule_order.get(item["type"], 99), item["type"] or "")),
    }


def _managed_readback(api, repository: str) -> dict[str, tuple[int, dict[str, Any]]]:
    summaries = _api_call("list", api.list_rulesets, repository)
    managed_names = {name for name, _ in MANAGED_RULESETS}
    found = {}
    for summary in summaries:
        name = summary.get("name")
        if name not in managed_names:
            continue
        if name in found:
            raise RulesetError(f"multiple GitHub rulesets named {name}")
        ruleset_id = summary.get("id")
        details = _api_call("read-back", api.get_ruleset, repository, ruleset_id)
        found[name] = (ruleset_id, details)
    return found


def plan_rulesets(
    api,
    repository: str,
    desired_rulesets: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Return deterministic create, update, or no-op operations."""
    unexpected = set(desired_rulesets) - {name for name, _ in MANAGED_RULESETS}
    if unexpected:
        raise ValueError(f"refusing to manage non-Harness rulesets: {sorted(unexpected)}")
    current = _managed_readback(api, repository)
    plan = []
    for name, _ in MANAGED_RULESETS:
        if name not in desired_rulesets:
            continue
        desired = dict(desired_rulesets[name])
        if name not in current:
            plan.append({"action": "create", "name": name, "payload": desired})
            continue
        ruleset_id, observed = current[name]
        action = "no-op" if normalize_ruleset(observed) == normalize_ruleset(desired) else "update"
        plan.append({"action": action, "name": name, "ruleset_id": ruleset_id, "payload": desired})
    return plan


def apply_ruleset_plan(api, repository: str, plan: Iterable[Mapping[str, Any]]) -> dict[str, list[str]]:
    """Apply only create/update operations through an injected API object."""
    result = {"created": [], "updated": [], "unchanged": []}
    for operation in plan:
        action = operation["action"]
        name = operation["name"]
        if action == "create":
            _api_call("create", api.create_ruleset, repository, dict(operation["payload"]))
            result["created"].append(name)
        elif action == "update":
            _api_call(
                "update",
                api.update_ruleset,
                repository,
                operation["ruleset_id"],
                dict(operation["payload"]),
            )
            result["updated"].append(name)
        elif action == "no-op":
            result["unchanged"].append(name)
        else:
            raise ValueError(f"unsupported ruleset plan action: {action}")
    return result


def verify_rulesets(
    bootstrap_api,
    repository: str,
    desired_rulesets: Mapping[str, Mapping[str, Any]],
    *,
    workflow_policy: Mapping[str, Any] | None = None,
    observed_workflow_policy: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Verify full managed ruleset read-back using bootstrap authority."""
    observed = _managed_readback(bootstrap_api, repository)
    verified = []
    for name, _ in MANAGED_RULESETS:
        if name not in desired_rulesets:
            continue
        if name not in observed:
            raise VerificationError(f"missing managed ruleset: {name}")
        _, actual = observed[name]
        if normalize_ruleset(actual) != normalize_ruleset(desired_rulesets[name]):
            raise VerificationError(f"managed ruleset read-back mismatch: {name}")
        verified.append(name)

    expected_policy = dict(PRODUCTION_WORKFLOW_POLICY if workflow_policy is None else workflow_policy)
    actual_policy = dict(observed_workflow_policy or {})
    if expected_policy != actual_policy:
        raise VerificationError("production workflow policy read-back mismatch")
    return {"verified": verified, "workflow_policy": expected_policy}
