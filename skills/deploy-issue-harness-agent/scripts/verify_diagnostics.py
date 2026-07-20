#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from harness_config import load_config  # noqa: E402

MAX_RESPONSE_BYTES = 1_000_000
READ_ONLY_TOOLS = {"health.read", "logs.query", "traces.query", "metrics.query", "deploy.status"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def secure_opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        NoRedirect(),
    )


def request_json(opener, url, token, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with opener.open(req, timeout=20) as response:
        if response.status != 200:
            raise ValueError(f"diagnostic endpoint returned HTTP {response.status}, expected 200")
        content_length = response.headers.get("content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError:
                raise ValueError("diagnostic response has an invalid Content-Length") from None
            if declared_length < 0 or declared_length > MAX_RESPONSE_BYTES:
                raise ValueError("diagnostic response exceeded the size limit")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("diagnostic response exceeded the size limit")
        payload = json.loads(raw) if raw else {}
        if not isinstance(payload, dict):
            raise ValueError("diagnostic endpoint must return a JSON object")
        return payload


def validate_endpoints(urls, allowed_origin, allow_http_localhost):
    allowed = urllib.parse.urlsplit(allowed_origin)
    if not allowed.hostname:
        raise ValueError("allowed origin must include a host")
    if allowed.username or allowed.password:
        raise ValueError("allowed origin must not contain userinfo")
    if allowed.path not in ("", "/") or allowed.query or allowed.fragment:
        raise ValueError("allowed origin must contain only scheme and host")
    try:
        allowed.port
    except ValueError:
        raise ValueError("allowed origin has an invalid port") from None
    if allowed.scheme != "https":
        local = allowed.hostname in ("127.0.0.1", "localhost", "::1")
        if not (allow_http_localhost and allowed.scheme == "http" and local):
            raise ValueError("diagnostics endpoints must use HTTPS")
    for url in urls:
        parsed = urllib.parse.urlsplit(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("diagnostics endpoint must not contain userinfo, query, or fragment")
        try:
            parsed.port
        except ValueError:
            raise ValueError("diagnostics endpoint has an invalid port") from None
        if (parsed.scheme, parsed.netloc) != (allowed.scheme, allowed.netloc):
            raise ValueError("all diagnostics endpoints must match the operator-supplied allowed origin")


def extract_log_items(payload):
    fields = [field for field in ("items", "logs") if field in payload]
    if len(fields) != 1:
        raise ValueError("diagnostic query must return exactly one bounded items or logs list")
    items = payload[fields[0]]
    if (
        not isinstance(items, list)
        or len(items) > 10
        or any(not isinstance(item, dict) for item in items)
    ):
        raise ValueError("diagnostic query must return exactly one bounded items or logs list")
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    parser.add_argument("--allowed-origin", required=True)
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--query-url", required=True)
    parser.add_argument("--policy-check-url", required=True)
    parser.add_argument("--credential-env", required=True)
    parser.add_argument("--allow-http-localhost", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path(args.repo).resolve()
    _, config = load_config(root)
    binding = config.get("observability", {})
    agent = config.get("productionAgent", {})
    required = ("provider", "service")
    missing = [key for key in required if not binding.get(key)]
    if binding.get("environment") != "production":
        missing.append("environment=production")
    if missing:
        raise ValueError("missing observability binding: " + ", ".join(missing))
    tools = agent.get("allowedTools")
    if agent.get("mode") != "diagnose-only" or agent.get("mutationPath") != "none":
        raise ValueError("productionAgent must use mode=diagnose-only and mutationPath=none")
    if not isinstance(tools, list) or not all(isinstance(tool, str) for tool in tools):
        raise ValueError("productionAgent.allowedTools must be a list of strings")
    if not {"health.read", "logs.query"}.issubset(tools):
        raise ValueError("productionAgent.allowedTools must include health.read and logs.query")
    unsupported_tools = sorted(set(tools) - READ_ONLY_TOOLS)
    if unsupported_tools:
        raise ValueError("productionAgent contains non-read-only tools: " + ", ".join(unsupported_tools))
    validate_endpoints(
        (args.health_url, args.query_url, args.policy_check_url),
        args.allowed_origin,
        args.allow_http_localhost,
    )
    token = os.getenv(args.credential_env)
    if not token:
        raise ValueError(f"missing credential environment variable {args.credential_env}")
    opener = secure_opener()
    request_json(opener, args.health_url, token)
    logs = request_json(opener, args.query_url, token, "POST", {
        "service": binding["service"], "environment": "production", "sinceMinutes": 15, "limit": 10,
    })
    items = extract_log_items(logs)
    if token in json.dumps(items):
        raise ValueError("diagnostic query returned its own credential")
    denied = []
    for action in ("deploy", "write", "shell", "sql.write"):
        decision = request_json(opener, args.policy_check_url, token, "POST", {"action": action})
        if decision.get("allowed") is not False:
            raise ValueError(f"diagnostic identity did not deny {action}")
        denied.append(action)
    print(json.dumps({"verified": True, "provider": binding["provider"], "logItems": len(items), "denied": denied}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, FileNotFoundError, json.JSONDecodeError, urllib.error.URLError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
