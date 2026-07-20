#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from harness_config import application_environment_refs, capabilities, load_config, normalize_config, single_capability  # noqa: E402
from harness_evidence import COOLIFY_INVENTORY_CONTRACT, validate_coolify_inventory  # noqa: E402
from harness_io import read_repository_file, repository_write_lock, validate_write_paths, write_config_cas_locked  # noqa: E402
from harness_safety import validate_harness_safety, validate_literal_id  # noqa: E402
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "assets"))
from coolify_client import AccessPolicy, CoolifyClient  # noqa: E402


ROLLBACK_REF = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[^\s@]+@sha256:[0-9a-fA-F]{64})$")


def validate_inventory_metadata(payload: object):
    errors = COOLIFY_INVENTORY_CONTRACT.validate(payload)
    if errors:
        raise ValueError("; ".join(errors))


def validate_inventory_payload(payload: object):
    errors = validate_coolify_inventory(payload)
    if errors:
        raise ValueError("; ".join(errors))


def desired(config: dict, *, allow_unresolved: bool = False):
    validate_harness_safety(config)
    try:
        project = config["project"]
        runtime = config["runtime"]
        coolify = config["coolify"]
        slug, repository = project["slug"], project["github"]
        port, health_path = runtime["port"], runtime["healthPath"]
    except KeyError as exc:
        raise ValueError(f"missing config field: {exc}") from None
    visibility = config["deployment"]["sourceVisibility"]
    application = single_capability(config, "coolify.application")
    required = ("projectUuid", "serverUuid") + (("githubAppUuid",) if visibility == "private" else ())
    missing = [key for key in required if not coolify.get(key)]
    if missing and not allow_unresolved:
        raise ValueError("missing coolify values: " + ", ".join(missing))
    stage_binding = application["bindings"]["stage"]
    production_binding = application["bindings"]["production"]
    if (not stage_binding.get("domain") or not production_binding.get("domain")) and not allow_unresolved:
        raise ValueError("stage and production domains are required")
    if stage_binding.get("domain") and stage_binding["domain"] == production_binding.get("domain"):
        raise ValueError("stage and production domains must differ")
    for capability in capabilities(config):
        if capability["kind"] not in {"coolify.postgresql", "convex.deployment"}:
            continue
        stage_ref = capability["bindings"]["stage"].get("resourceRef")
        production_ref = capability["bindings"]["production"].get("resourceRef")
        if (not stage_ref or not production_ref) and allow_unresolved:
            continue
        if not stage_ref or not production_ref or stage_ref == production_ref:
            raise ValueError(
                f"capability {capability['id']} stage and production resourceRef values must be present and distinct"
            )
        if capability["kind"] == "coolify.postgresql":
            providers = {capability["bindings"][lane].get("provider") for lane in ("stage", "production")}
            if providers != {"coolify-postgresql"}:
                raise ValueError("PostgreSQL capability bindings must use provider=coolify-postgresql")
        if capability["kind"] == "convex.deployment":
            project_refs = [capability["bindings"][lane].get("projectRef") for lane in ("stage", "production")]
            if any(not ref for ref in project_refs) and allow_unresolved:
                continue
            if any(not ref for ref in project_refs) or project_refs[0] == project_refs[1]:
                raise ValueError("Convex stage and production projectRef values must be present and distinct")
    required_env = config.get("deployment", {}).get("requiredEnvironmentVariables", [])
    for lane in ("stage", "production"):
        refs = application_environment_refs(config, lane)
        missing_env = [key for key in required_env if not refs.get(key)]
        if missing_env:
            raise ValueError(f"{lane} is missing environmentVariableRefs for: {', '.join(missing_env)}")

    service_root = str(application.get("root", project.get("serviceRoot", "."))).strip("/")
    base_directory = "/" if service_root in ("", ".") else f"/{service_root}"
    deployment = config.get("deployment", {})
    dockerfile = str(deployment.get("dockerfile", "Dockerfile")).lstrip("/")
    dockerfile_location = f"/{dockerfile}"
    compose_location = deployment.get("composeFile")
    result = []
    for lane, branch in (("stage", "stage"), ("production", "main")):
        binding = application["bindings"][lane]
        result.append({
            "lane": lane,
            "uuid": binding.get("resourceRef"),
            "name": f"{slug}-{lane}",
            "project_uuid": coolify["projectUuid"],
            "server_uuid": coolify["serverUuid"],
            "environment_name": binding.get("environment", lane),
            "github_app_uuid": coolify.get("githubAppUuid") if visibility == "private" else None,
            "git_repository": repository,
            "git_branch": branch,
            "build_pack": deployment.get("buildPack", "dockerfile"),
            "ports_exposes": str(port),
            "health_check_path": health_path,
            "health_check_enabled": True,
            "domains": binding.get("domain"),
            "is_auto_deploy_enabled": False,
            "base_directory": base_directory,
            "dockerfile_location": dockerfile_location,
            "docker_compose_location": f'/{str(compose_location).lstrip("/")}' if compose_location else None,
            "_create_endpoint": "/applications/private-github-app" if visibility == "private" else "/applications/public",
        })
    if result[0]["uuid"] and result[0]["uuid"] == result[1]["uuid"]:
        raise ValueError("stage and production application UUIDs must differ")
    return result


def application_payload(item: dict):
    return {
        key: value for key, value in item.items()
        if key not in ("lane", "uuid") and not key.startswith("_") and value is not None
    }


def response_records(response: object, label: str, *envelope_fields: str) -> list[dict]:
    if isinstance(response, list):
        records = response
    elif isinstance(response, dict):
        fields = [field for field in ("data", *envelope_fields) if field in response]
        if len(fields) != 1:
            raise RuntimeError(f"{label} response must contain one record list")
        records = response[fields[0]]
    else:
        raise RuntimeError(f"{label} response must contain one record list")
    if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
        raise RuntimeError(f"{label} response must contain one record list")
    return records


def response_object(response: object, label: str) -> dict:
    if not isinstance(response, dict):
        raise RuntimeError(f"{label} response must be an object")
    return response


def listed_applications(client: CoolifyClient):
    response = client.request("GET", "/applications")
    return response_records(response, "applications", "applications")


def normalized_repository(value):
    text = str(value or "").removesuffix(".git").rstrip("/")
    for prefix in ("https://github.com/", "git@github.com:"):
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


def identity_matches(remote: dict, item: dict):
    return (
        remote.get("name") == item["name"]
        and normalized_repository(remote.get("git_repository")) == normalized_repository(item["git_repository"])
        and remote.get("git_branch") == item["git_branch"]
    )


def inventory_matches(record: dict, item: dict):
    return (
        record.get("applicationUuid") == item.get("uuid")
        and record.get("projectUuid") == item["project_uuid"]
        and record.get("serverUuid") == item["server_uuid"]
        and record.get("environmentName") == item["environment_name"]
        and record.get("name") == item["name"]
        and normalized_repository(record.get("repository")) == normalized_repository(item["git_repository"])
        and record.get("branch") == item["git_branch"]
        and record.get("domain") == item["domains"]
    )


MANAGED_UPDATE_FIELDS = (
    "git_repository", "git_branch", "build_pack", "ports_exposes", "health_check_path",
    "domains", "is_auto_deploy_enabled", "base_directory", "dockerfile_location",
    "docker_compose_location", "health_check_enabled",
)


def drift(remote: dict, item: dict):
    aliases = {"domains": "fqdn"}
    changes = {}
    for key in MANAGED_UPDATE_FIELDS:
        remote_value = remote.get(key)
        if remote_value is None and key in aliases:
            remote_value = remote.get(aliases[key])
        if remote_value != item.get(key):
            changes[key] = item[key]
    return changes


def ensure_environments(client: CoolifyClient, project_uuid: str, names: list[str]):
    validate_literal_id(project_uuid, "Coolify project UUID")
    path = client.literal_path("projects", project_uuid, "environments")
    response = client.request("GET", path)
    environments = response_records(response, "environments", "environments")
    existing = {item.get("name") for item in environments}
    for name in names:
        if name not in existing:
            client.request("POST", path, {"name": name})


def verify_postgresql_backends(config: dict, database_inventory: list):
    postgres_capabilities = capabilities(config, "coolify.postgresql")
    if not postgres_capabilities:
        return []
    if not database_inventory:
        raise ValueError("NestJS/PostgreSQL verification requires canonical databases in --inventory-json")
    report = []
    for capability in postgres_capabilities:
        for lane in ("stage", "production"):
            binding = capability["bindings"][lane]
            uuid = binding["resourceRef"]
            matches = [database for database in database_inventory if database.get("databaseUuid") == uuid]
            if len(matches) != 1:
                raise RuntimeError(f"Coolify PostgreSQL backend {uuid} for {lane} was not found uniquely")
            database = matches[0]
            expected = {
                "databaseType": "postgresql",
                "projectUuid": config["coolify"]["projectUuid"],
                "serverUuid": config["coolify"]["serverUuid"],
                "environmentName": binding.get("environment", lane),
                "ready": True,
                "readinessSource": "coolify-health",
            }
            mismatches = [key for key, value in expected.items() if database.get(key) != value]
            if mismatches:
                raise RuntimeError(f"Coolify PostgreSQL backend {uuid} for {lane} has wrong {', '.join(mismatches)}")
            report.append({"capability": capability["id"], "lane": lane, "uuid": uuid, "ready": True, "verified": True})
    return report


def verify_convex_deployments(config: dict, deployment_inventory: list):
    convex_capabilities = capabilities(config, "convex.deployment")
    if not convex_capabilities:
        return []
    if not deployment_inventory:
        raise ValueError("Convex verification requires canonical convexDeployments in --inventory-json")
    report = []
    for capability in convex_capabilities:
        for lane in ("stage", "production"):
            binding = capability["bindings"][lane]
            matches = [
                deployment for deployment in deployment_inventory
                if deployment.get("capabilityId") == capability["id"] and deployment.get("lane") == lane
            ]
            if len(matches) != 1:
                raise RuntimeError(f"Convex deployment for {capability['id']}.{lane} was not found uniquely")
            deployment = matches[0]
            expected = {
                "projectRef": binding.get("projectRef"),
                "deploymentRef": binding.get("resourceRef"),
                "deploymentType": "permanent",
                "deployKeyRef": binding.get("deployKeyRef"),
                "deployKeyScope": binding.get("resourceRef"),
                "ready": True,
                "readinessSource": "convex-deployment",
            }
            mismatches = [key for key, value in expected.items() if deployment.get(key) != value]
            if mismatches:
                raise RuntimeError(
                    f"Convex deployment for {capability['id']}.{lane} has wrong {', '.join(mismatches)}"
                )
            report.append({
                "capability": capability["id"],
                "lane": lane,
                "projectRef": binding["projectRef"],
                "deploymentRef": binding["resourceRef"],
                "ready": True,
                "verified": True,
            })
    return report


def verify_delivery_environments(config: dict, environment_inventory: list):
    if not environment_inventory:
        raise ValueError("delivery verification requires canonical deliveryEnvironments in --inventory-json")
    policy = config["deliveryPolicy"]["production"]
    report = []
    records = {}
    for lane in ("stage", "production"):
        matches = [record for record in environment_inventory if record.get("lane") == lane]
        if len(matches) != 1:
            raise RuntimeError(f"delivery environment for {lane} was not found uniquely")
        records[lane] = matches[0]
    if records["stage"].get("credentialScope") == records["production"].get("credentialScope"):
        raise RuntimeError("delivery environment credentialScope values must be distinct")
    expected = {
        "stage": {
            "environmentName": "stage",
            "branch": config["branches"]["stage"],
            "credentialScope": "github-environment:stage",
        },
        "production": {
            "environmentName": policy["githubEnvironment"],
            "branch": config["branches"]["production"],
            "credentialScope": "github-environment:production",
            "requiredReviewers": policy["requiredReviewers"],
            "preventSelfReview": policy["preventSelfReview"],
        },
    }
    for lane in ("stage", "production"):
        mismatches = [key for key, value in expected[lane].items() if records[lane].get(key) != value]
        if mismatches:
            raise RuntimeError(f"delivery environment for {lane} has wrong {', '.join(mismatches)}")
        report.append({"lane": lane, "credentialScope": records[lane]["credentialScope"], "verified": True})
    return report


def resolve_environment_values(config: dict):
    values = {}
    for lane in ("stage", "production"):
        refs = application_environment_refs(config, lane)
        values[lane] = {}
        for key, source_env in refs.items():
            value = os.getenv(source_env)
            if value is None:
                raise ValueError(f"missing operator environment variable {source_env} for {lane}.{key}")
            values[lane][key] = value
    for key in config.get("deployment", {}).get("distinctEnvironmentVariables", []):
        stage_value = values.get("stage", {}).get(key)
        production_value = values.get("production", {}).get(key)
        if stage_value is None or production_value is None or stage_value == production_value:
            raise ValueError(f"stage and production values for {key} must be present and distinct")
    return values


def value_sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def environment_value_verified(environment_inventory: list, application_uuid: str, key: str, value: str) -> bool:
    matches = [
        record for record in environment_inventory
        if record.get("applicationUuid") == application_uuid and record.get("key") == key
    ]
    return len(matches) == 1 and matches[0].get("valueSha256") == value_sha256(value)


def reconcile_application_envs(
    client: CoolifyClient,
    items: list,
    config: dict,
    values: dict,
    environment_inventory: list,
    allow_create: bool,
):
    report = []
    for item in items:
        response = client.request("GET", client.literal_path("applications", item["uuid"], "envs"))
        envs = response_records(response, "application environment variables", "envs")
        existing = {entry.get("key") for entry in envs}
        refs = application_environment_refs(config, item["lane"])
        created, verified_keys, unverified = [], [], []
        for key in refs:
            if key not in existing and allow_create:
                client.request("POST", client.literal_path("applications", item["uuid"], "envs"), {
                    "key": key, "value": values[item["lane"]][key], "is_literal": True,
                })
                existing.add(key)
                created.append(key)
                verified_keys.append(key)
            elif key in existing:
                if environment_value_verified(
                    environment_inventory, item["uuid"], key, values[item["lane"]][key]
                ):
                    verified_keys.append(key)
                else:
                    unverified.append(key)
        missing = sorted(set(refs) - existing)
        report.append({
            "lane": item["lane"],
            "verifiedKeys": sorted(verified_keys),
            "created": created,
            "missing": missing,
            "presentUnverified": sorted(unverified),
            "verified": not missing and not unverified,
        })
    return report


def matching_inventory_record(inventory_records: list, item: dict):
    matches = [record for record in inventory_records if inventory_matches(record, item)]
    if len(matches) != 1:
        raise RuntimeError(f'fresh inventory did not identify {item["lane"]} application uniquely')
    return matches[0]


def validate_remote_application(remote: dict, item: dict):
    if not identity_matches(remote, item):
        raise RuntimeError(f'stored {item["lane"]} application UUID does not match name/repository/branch')
    remote_domain = remote.get("domains", remote.get("fqdn"))
    if remote_domain and remote_domain != item.get("domains"):
        raise RuntimeError(f'refusing to override occupied {item["lane"]} domain')


def preflight_applications(client: CoolifyClient, items: list, inventory_records: list):
    """Resolve and validate every existing application before the first external write."""
    inventory = listed_applications(client)
    prepared = {}
    for item in items:
        if item["uuid"]:
            app_uuid = item["uuid"]
            matching_inventory_record(inventory_records, item)
            remote = response_object(
                client.request("GET", client.literal_path("applications", app_uuid)),
                f'{item["lane"]} application',
            )
            validate_remote_application(remote, item)
            prepared[item["lane"]] = remote
        else:
            matches = [app for app in inventory if identity_matches(app, item)]
            if len(matches) > 1:
                raise RuntimeError(f'ambiguous existing Coolify applications for {item["lane"]}')
            if matches:
                app_uuid = matches[0].get("uuid")
                if not app_uuid:
                    raise RuntimeError(f'existing {item["lane"]} application has no UUID')
                validate_literal_id(app_uuid, f'{item["lane"]} discovered application UUID')
                item["uuid"] = app_uuid
                matching_inventory_record(inventory_records, item)
                remote = response_object(
                    client.request("GET", client.literal_path("applications", app_uuid)),
                    f'{item["lane"]} application',
                )
                validate_remote_application(remote, item)
                prepared[item["lane"]] = remote
            else:
                prepared[item["lane"]] = None
    return prepared


def preflight_existing_environment_values(client: CoolifyClient, items: list, config: dict, values: dict, environment_inventory: list):
    """Refuse unproven existing secret values before creating or patching anything."""
    for item in items:
        if not item["uuid"]:
            continue
        response = client.request("GET", client.literal_path("applications", item["uuid"], "envs"))
        envs = response_records(response, "application environment variables", "envs")
        existing = {entry.get("key") for entry in envs}
        refs = application_environment_refs(config, item["lane"])
        unverified = [
            key for key in refs
            if key in existing and not environment_value_verified(
                environment_inventory, item["uuid"], key, values[item["lane"]][key]
            )
        ]
        if unverified:
            raise RuntimeError(
                f'existing {item["lane"]} environment values lack matching canonical fingerprints: '
                + ", ".join(sorted(unverified))
            )


def apply(
    config_path: pathlib.Path,
    config: dict,
    client: CoolifyClient,
    items: list,
    inventory_records: list,
    environment_values: dict,
    environment_inventory: list,
    expected_config_sha256: str,
):
    application = single_capability(config, "coolify.application")
    prepared = preflight_applications(client, items, inventory_records)
    preflight_existing_environment_values(client, items, config, environment_values, environment_inventory)
    ensure_environments(
        client,
        config["coolify"]["projectUuid"],
        list(dict.fromkeys(item["environment_name"] for item in items)),
    )
    for item in items:
        payload = application_payload(item)
        remote = prepared[item["lane"]]
        app_uuid = item["uuid"]
        if remote is None:
            response = response_object(
                client.request("POST", item["_create_endpoint"], payload),
                f'{item["lane"]} application creation',
            )
            app_uuid = response.get("uuid")
            if not app_uuid:
                raise RuntimeError(f'Coolify did not return a UUID for {item["lane"]}')
            validate_literal_id(app_uuid, f'{item["lane"]} created application UUID')
            item["uuid"] = app_uuid
            remote = response_object(
                client.request("GET", client.literal_path("applications", app_uuid)),
                f'{item["lane"]} application',
            )
            validate_remote_application(remote, item)
        changes = drift(remote, item)
        if changes:
            client.request("PATCH", client.literal_path("applications", app_uuid), changes)
        item["uuid"] = app_uuid
        application["bindings"][item["lane"]]["resourceRef"] = app_uuid
    write_config_cas_locked(config_path.parents[1], config, expected_config_sha256)
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    parser.add_argument("mode", choices=("plan", "apply", "verify"))
    parser.add_argument("--allow-external-writes", action="store_true")
    parser.add_argument("--allow-production-writes", action="store_true")
    parser.add_argument("--production-approval-ref")
    parser.add_argument("--rollback-ref")
    parser.add_argument("--inventory-json", help="operator-generated canonical application inventory")
    args = parser.parse_args()
    root = pathlib.Path(args.repo).resolve()
    if args.mode == "apply":
        validate_write_paths(root, (root / ".harness" / "config.json",))
        with repository_write_lock(root):
            return _execute(args, root)
    return _execute(args, root)


def _execute(args, root: pathlib.Path) -> int:
    if args.mode == "apply":
        config_path = root / ".harness" / "config.json"
        raw_config = read_repository_file(root, config_path)
        assert raw_config is not None
        expected_config_sha256 = hashlib.sha256(raw_config).hexdigest()
        config = normalize_config(json.loads(raw_config))
    else:
        config_path, config = load_config(root)
        expected_config_sha256 = None
    if args.mode == "plan":
        items = desired(config, allow_unresolved=True)
        actions = []
        for item in items:
            actions.append({
                "category": "application",
                "lane": item["lane"],
                "action": "verify-and-patch" if item["uuid"] else "resolve-or-create",
                "resolved": bool(item["uuid"] and item.get("project_uuid") and item.get("server_uuid") and item.get("domains")),
                "desired": application_payload(item),
            })
        backend_actions = []
        for capability in capabilities(config):
            if capability["kind"] not in {"coolify.postgresql", "convex.deployment"}:
                continue
            for lane in ("stage", "production"):
                binding = capability["bindings"][lane]
                required = ["resourceRef"] + (["projectRef"] if capability["kind"] == "convex.deployment" else [])
                backend_actions.append({
                    "category": "postgresql" if capability["kind"] == "coolify.postgresql" else "convex",
                    "capabilityId": capability["id"],
                    "lane": lane,
                    "action": "verify-binding" if all(binding.get(key) for key in required) else "resolve-binding",
                    "resolved": all(binding.get(key) for key in required),
                    "credentialRef": binding.get("credentialRef") or binding.get("deployKeyRef"),
                })
        credential_actions = []
        for lane in ("stage", "production"):
            for variable, credential_ref in sorted(application_environment_refs(config, lane).items()):
                credential_actions.append({
                    "category": "credential",
                    "lane": lane,
                    "applicationVariable": variable,
                    "credentialRef": credential_ref,
                    "action": "bind-environment-scoped-reference",
                    "resolved": bool(credential_ref),
                })
        approval_actions = [
            {
                "category": "approval",
                "lane": "stage",
                "action": "automatic-isolated-stage-gates",
                "resolved": True,
            },
            {
                "category": "approval",
                "lane": "production",
                "action": "protected-backend-prepare-then-exact-application-rollout",
                "resolved": False,
                "requiredEvidence": [
                    "preparedRevision", "previousRevision", "backupRef", "expandOnlyEvidence",
                    "separateProtectedApproval",
                ],
                "contractMigration": "separate-post-application-approval-only",
            },
        ]
        print(json.dumps({
            "externalAccess": False,
            "actions": actions,
            "backendActions": backend_actions,
            "credentialActions": credential_actions,
            "approvalActions": approval_actions,
        }, indent=2))
        return 0
    items = desired(config)

    if args.mode == "apply":
        missing_controls = []
        if not args.allow_production_writes:
            missing_controls.append("--allow-production-writes")
        if not args.production_approval_ref:
            missing_controls.append("--production-approval-ref")
        if not args.rollback_ref:
            missing_controls.append("--rollback-ref")
        if missing_controls:
            raise ValueError("production reconciliation requires " + ", ".join(missing_controls))
        if any(character.isspace() for character in args.production_approval_ref) or len(args.production_approval_ref) > 200:
            raise ValueError("--production-approval-ref must be a bounded non-secret reference")
        if not ROLLBACK_REF.fullmatch(args.rollback_ref):
            raise ValueError("--rollback-ref must be a full Git commit or canonical image digest")
        production_change_control = {
            "approvalRef": args.production_approval_ref,
            "rollbackRef": args.rollback_ref,
            "rollbackStrategy": config["deliveryPolicy"]["rollback"]["strategy"],
        }
    else:
        production_change_control = None

    base, token = os.getenv("COOLIFY_URL"), os.getenv("COOLIFY_TOKEN")
    if not base or not token:
        raise ValueError("COOLIFY_URL and COOLIFY_TOKEN are required")
    access_policy = AccessPolicy.from_environment(
        "reconcile" if args.mode == "apply" else "verify",
        os.environ,
    )
    client = CoolifyClient(
        base,
        token,
        access_policy,
        allow_insecure_loopback=os.getenv("HARNESS_TEST_ALLOW_INSECURE_LOOPBACK") == "1",
    )
    inventory_records = []
    database_inventory = []
    convex_inventory = []
    delivery_inventory = []
    environment_inventory = []
    if args.inventory_json:
        inventory_payload = json.loads(pathlib.Path(args.inventory_json).read_text())
        validate_inventory_payload(inventory_payload)
        inventory_records = inventory_payload.get("applications", [])
        database_inventory = inventory_payload.get("databases", [])
        convex_inventory = inventory_payload.get("convexDeployments", [])
        delivery_inventory = inventory_payload.get("deliveryEnvironments", [])
        environment_inventory = inventory_payload.get("environmentVariables", [])
    if args.mode == "verify" and not inventory_records:
        raise ValueError("verify requires --inventory-json from a fresh Coolify API/UI inventory")
    backend_report = verify_postgresql_backends(config, database_inventory)
    backend_report.extend(verify_convex_deployments(config, convex_inventory))
    delivery_report = verify_delivery_environments(config, delivery_inventory)
    environment_values = resolve_environment_values(config)
    if args.mode == "apply":
        if not args.allow_external_writes:
            raise ValueError("apply requires --allow-external-writes")
        items = apply(
            config_path,
            config,
            client,
            items,
            inventory_records,
            environment_values,
            environment_inventory,
            expected_config_sha256,
        )
    environment_report = reconcile_application_envs(
        client,
        items,
        config,
        environment_values,
        environment_inventory,
        allow_create=args.mode == "apply",
    )
    report = []
    for item in items:
        if not item["uuid"]:
            report.append({"lane": item["lane"], "verified": False, "reason": "application UUID is unbound"})
            continue
        remote = response_object(
            client.request("GET", client.literal_path("applications", item["uuid"])),
            f'{item["lane"]} application',
        )
        mismatches = []
        if not identity_matches(remote, item):
            mismatches.append("identity")
        mismatches.extend(drift(remote, item).keys())
        if inventory_records:
            try:
                matching_inventory_record(inventory_records, item)
            except RuntimeError:
                mismatches.append("project/environment/server inventory")
        report.append({"lane": item["lane"], "verified": not mismatches, "uuid": item["uuid"], "mismatches": sorted(set(mismatches))})
    output = {
        "applications": report,
        "dataBackends": backend_report,
        "deliveryEnvironments": delivery_report,
        "environmentVariables": environment_report,
    }
    if production_change_control:
        output["productionChangeControl"] = production_change_control
    output["accessPolicy"] = access_policy.evidence()
    print(json.dumps(output, indent=2))
    return 0 if all(item["verified"] for item in report + environment_report) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, FileNotFoundError, json.JSONDecodeError, TypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
