#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


class Coolify:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/") + "/api/v1"
        self.token = token

    def request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            exc.read()
            raise RuntimeError(
                f"Coolify {method} {path} failed with HTTP {exc.code}; response body withheld because it may contain secrets"
            ) from None


def load_config(root: pathlib.Path):
    path = root / ".harness" / "config.json"
    return path, json.loads(path.read_text())


def validate_inventory_metadata(payload: object):
    if not isinstance(payload, dict):
        raise ValueError("--inventory-json must be an object with metadata and canonical sections")
    if payload.get("source") not in ("coolify-api", "coolify-ui"):
        raise ValueError("inventory source must be coolify-api or coolify-ui")
    observed_at = payload.get("observedAt")
    if not isinstance(observed_at, str):
        raise ValueError("inventory observedAt must be an ISO-8601 timestamp with timezone")
    try:
        observed = datetime.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        if observed.tzinfo is None:
            raise ValueError("timezone is required")
    except ValueError:
        raise ValueError("inventory observedAt must be an ISO-8601 timestamp with timezone") from None
    age = datetime.datetime.now(datetime.timezone.utc) - observed.astimezone(datetime.timezone.utc)
    if age > datetime.timedelta(minutes=10) or age < datetime.timedelta(minutes=-2):
        raise ValueError("inventory observedAt must be a fresh timestamp from the last 10 minutes")


def desired(config: dict):
    try:
        project = config["project"]
        runtime = config["runtime"]
        coolify = config["coolify"]
        slug, repository = project["slug"], project["github"]
        port, health_path = runtime["port"], runtime["healthPath"]
    except KeyError as exc:
        raise ValueError(f"missing config field: {exc}") from None
    visibility = config.get("deployment", {}).get("sourceVisibility", "private")
    if visibility not in ("private", "public"):
        raise ValueError("deployment.sourceVisibility must be private or public")
    if project.get("stack") not in ("nest-postgres", "convex", "hybrid"):
        raise ValueError("project.stack must be nest-postgres, convex, or hybrid")
    required = ("projectUuid", "serverUuid") + (("githubAppUuid",) if visibility == "private" else ())
    missing = [key for key in required if not coolify.get(key)]
    if missing:
        raise ValueError("missing coolify values: " + ", ".join(missing))
    stage_binding, production_binding = coolify.get("stage", {}), coolify.get("production", {})
    if not stage_binding.get("domain") or not production_binding.get("domain"):
        raise ValueError("stage and production domains are required")
    if stage_binding["domain"] == production_binding["domain"]:
        raise ValueError("stage and production domains must differ")
    if project.get("stack") in ("convex", "nest-postgres", "hybrid"):
        stage_backend = stage_binding.get("dataBackendRef")
        production_backend = production_binding.get("dataBackendRef")
        if not stage_backend or not production_backend or stage_backend == production_backend:
            raise ValueError("stage and production dataBackendRef values must be present and distinct")
    if project.get("stack") == "nest-postgres":
        providers = {stage_binding.get("dataBackendProvider"), production_binding.get("dataBackendProvider")}
        if providers != {"coolify-postgresql"}:
            raise ValueError("NestJS/PostgreSQL bindings must use dataBackendProvider=coolify-postgresql")
    required_env = config.get("deployment", {}).get("requiredEnvironmentVariables", [])
    for lane, binding in (("stage", stage_binding), ("production", production_binding)):
        refs = binding.get("environmentVariableRefs", {})
        missing_env = [key for key in required_env if not refs.get(key)]
        if missing_env:
            raise ValueError(f"{lane} is missing environmentVariableRefs for: {', '.join(missing_env)}")

    service_root = str(project.get("serviceRoot", ".")).strip("/")
    base_directory = "/" if service_root in ("", ".") else f"/{service_root}"
    deployment = config.get("deployment", {})
    dockerfile = str(deployment.get("dockerfile", "Dockerfile")).lstrip("/")
    dockerfile_location = f"/{dockerfile}"
    compose_location = deployment.get("composeFile")
    result = []
    for lane, branch in (("stage", "stage"), ("production", "main")):
        binding = coolify[lane]
        result.append({
            "lane": lane,
            "uuid": binding.get("applicationUuid"),
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


def listed_applications(client: Coolify):
    response = client.request("GET", "/applications")
    if isinstance(response, list):
        return response
    return response.get("data", response.get("applications", []))


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


def ensure_environments(client: Coolify, project_uuid: str, names: list[str]):
    response = client.request("GET", f"/projects/{project_uuid}/environments")
    environments = response if isinstance(response, list) else response.get("data", response.get("environments", []))
    existing = {item.get("name") for item in environments if isinstance(item, dict)}
    for name in names:
        if name not in existing:
            client.request("POST", f"/projects/{project_uuid}/environments", {"name": name})


def verify_postgresql_backends(config: dict, database_inventory: list):
    if config.get("project", {}).get("stack") != "nest-postgres":
        return []
    if not database_inventory:
        raise ValueError("NestJS/PostgreSQL verification requires canonical databases in --inventory-json")
    report = []
    for lane in ("stage", "production"):
        binding = config["coolify"][lane]
        uuid = binding["dataBackendRef"]
        matches = [database for database in database_inventory if database.get("databaseUuid") == uuid]
        if len(matches) != 1:
            raise RuntimeError(f"Coolify PostgreSQL backend {uuid} for {lane} was not found uniquely")
        database = matches[0]
        expected = {
            "databaseType": "postgresql",
            "projectUuid": config["coolify"]["projectUuid"],
            "serverUuid": config["coolify"]["serverUuid"],
            "environmentName": binding.get("environment", lane),
        }
        mismatches = [key for key, value in expected.items() if database.get(key) != value]
        if mismatches:
            raise RuntimeError(f"Coolify PostgreSQL backend {uuid} for {lane} has wrong {', '.join(mismatches)}")
        report.append({"lane": lane, "uuid": uuid, "verified": True})
    return report


def resolve_environment_values(config: dict):
    values = {}
    for lane in ("stage", "production"):
        refs = config["coolify"][lane].get("environmentVariableRefs", {})
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
    client: Coolify,
    items: list,
    config: dict,
    values: dict,
    environment_inventory: list,
    allow_create: bool,
):
    report = []
    for item in items:
        response = client.request("GET", f'/applications/{item["uuid"]}/envs')
        envs = response if isinstance(response, list) else response.get("data", response.get("envs", []))
        existing = {entry.get("key") for entry in envs if isinstance(entry, dict)}
        refs = config["coolify"][item["lane"]].get("environmentVariableRefs", {})
        created, verified_keys, unverified = [], [], []
        for key in refs:
            if key not in existing and allow_create:
                client.request("POST", f'/applications/{item["uuid"]}/envs', {
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


def preflight_applications(client: Coolify, items: list, inventory_records: list):
    """Resolve and validate every existing application before the first external write."""
    inventory = listed_applications(client)
    prepared = {}
    for item in items:
        if item["uuid"]:
            app_uuid = item["uuid"]
            matching_inventory_record(inventory_records, item)
            remote = client.request("GET", f"/applications/{app_uuid}")
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
                item["uuid"] = app_uuid
                matching_inventory_record(inventory_records, item)
                remote = client.request("GET", f"/applications/{app_uuid}")
                validate_remote_application(remote, item)
                prepared[item["lane"]] = remote
            else:
                prepared[item["lane"]] = None
    return prepared


def preflight_existing_environment_values(client: Coolify, items: list, config: dict, values: dict, environment_inventory: list):
    """Refuse unproven existing secret values before creating or patching anything."""
    for item in items:
        if not item["uuid"]:
            continue
        response = client.request("GET", f'/applications/{item["uuid"]}/envs')
        envs = response if isinstance(response, list) else response.get("data", response.get("envs", []))
        existing = {entry.get("key") for entry in envs if isinstance(entry, dict)}
        refs = config["coolify"][item["lane"]].get("environmentVariableRefs", {})
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
    client: Coolify,
    items: list,
    inventory_records: list,
    environment_values: dict,
    environment_inventory: list,
):
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
            response = client.request("POST", item["_create_endpoint"], payload)
            app_uuid = response.get("uuid")
            if not app_uuid:
                raise RuntimeError(f'Coolify did not return a UUID for {item["lane"]}')
            item["uuid"] = app_uuid
            remote = client.request("GET", f"/applications/{app_uuid}")
            validate_remote_application(remote, item)
        changes = drift(remote, item)
        if changes:
            client.request("PATCH", f"/applications/{app_uuid}", changes)
        item["uuid"] = app_uuid
        config["coolify"][item["lane"]]["applicationUuid"] = app_uuid
    temporary = config_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(config, indent=2) + "\n")
    temporary.replace(config_path)
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    parser.add_argument("mode", choices=("plan", "apply", "verify"))
    parser.add_argument("--allow-external-writes", action="store_true")
    parser.add_argument("--inventory-json", help="operator-generated canonical application inventory")
    args = parser.parse_args()
    root = pathlib.Path(args.repo).resolve()
    config_path, config = load_config(root)
    items = desired(config)
    if args.mode == "plan":
        print(json.dumps({"actions": [{"lane": i["lane"], "action": "verify-and-patch" if i["uuid"] else "resolve-or-create", "desired": application_payload(i)} for i in items]}, indent=2))
        return 0

    base, token = os.getenv("COOLIFY_URL"), os.getenv("COOLIFY_TOKEN")
    if not base or not token:
        raise ValueError("COOLIFY_URL and COOLIFY_TOKEN are required")
    client = Coolify(base, token)
    inventory_records = []
    database_inventory = []
    environment_inventory = []
    if args.inventory_json:
        inventory_payload = json.loads(pathlib.Path(args.inventory_json).read_text())
        validate_inventory_metadata(inventory_payload)
        inventory_records = inventory_payload.get("applications", [])
        database_inventory = inventory_payload.get("databases", [])
        environment_inventory = inventory_payload.get("environmentVariables", [])
    if args.mode == "verify" and not inventory_records:
        raise ValueError("verify requires --inventory-json from a fresh Coolify API/UI inventory")
    backend_report = verify_postgresql_backends(config, database_inventory)
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
        remote = client.request("GET", f'/applications/{item["uuid"]}')
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
    print(json.dumps({"applications": report, "dataBackends": backend_report, "environmentVariables": environment_report}, indent=2))
    return 0 if all(item["verified"] for item in report + environment_report) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, FileNotFoundError, json.JSONDecodeError, TypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
