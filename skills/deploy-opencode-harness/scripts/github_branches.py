#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, NamedTuple, Optional


API_VERSION = "2022-11-28"
MAIN_REF = "refs/heads/main"
STAGE_REF = "refs/heads/stage"
SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class ApiResponse(NamedTuple):
    status: int
    payload: object = None


Transport = Callable[[str, str, dict, Optional[bytes]], ApiResponse]


def urllib_transport(method, url, headers, body):
    request = urllib.request.Request(
        url=url,
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return ApiResponse(response.status, _decode_json(response.read()))
    except urllib.error.HTTPError as error:
        return ApiResponse(error.code, _decode_json(error.read()))
    except urllib.error.URLError as error:
        return ApiResponse(0, {"message": str(error.reason)})


def _decode_json(raw):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"message": "GitHub API returned a malformed response"}


def _headers(token, has_body=False):
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "deploy-opencode-harness",
    }
    if has_body:
        headers["Content-Type"] = "application/json"
    return headers


def _request(transport, method, url, token, payload=None):
    body = None
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    response = transport(method, url, _headers(token, body is not None), body)
    if not isinstance(response, ApiResponse):
        try:
            response = ApiResponse(status=response.status, payload=response.payload)
        except (AttributeError, TypeError) as error:
            raise TypeError("transport must return ApiResponse") from error
    return response


def _redact_text(value, token):
    text = str(value or "GitHub API request failed")
    if token:
        text = text.replace(token, "[REDACTED]")
    return text[:500]


def _response_message(response, token):
    if isinstance(response.payload, dict):
        message = response.payload.get("message")
        if isinstance(message, str) and message:
            return _redact_text(message, token)
    return _redact_text(f"GitHub API request failed with HTTP {response.status}", token)


def _parse_ref(payload, expected_ref):
    if not isinstance(payload, dict) or payload.get("ref") != expected_ref:
        return None
    target = payload.get("object")
    if not isinstance(target, dict) or target.get("type") != "commit":
        return None
    sha = target.get("sha")
    if not isinstance(sha, str) or SHA_PATTERN.fullmatch(sha) is None:
        return None
    return sha


def _base_result(repository, mode):
    return {
        "schemaVersion": 1,
        "repository": repository,
        "mode": mode,
        "main": {"ref": MAIN_REF, "exists": False},
        "stage": {"ref": STAGE_REF, "exists": False},
        "actions": [],
    }


def _blocked(result, code, message, http_status=None):
    result["status"] = "blocked"
    result["error"] = {"code": code, "message": message}
    if http_status is not None:
        result["error"]["httpStatus"] = http_status
    return result


def _ref_url(api_url, repository, branch):
    owner, name = repository.split("/", 1)
    encoded_repository = "/".join((
        urllib.parse.quote(owner, safe=""),
        urllib.parse.quote(name, safe=""),
    ))
    return f"{api_url.rstrip('/')}/repos/{encoded_repository}/git/ref/heads/{branch}"


def _refs_url(api_url, repository):
    owner, name = repository.split("/", 1)
    encoded_repository = "/".join((
        urllib.parse.quote(owner, safe=""),
        urllib.parse.quote(name, safe=""),
    ))
    return f"{api_url.rstrip('/')}/repos/{encoded_repository}/git/refs"


def bootstrap_repository_branches(
    repository,
    token,
    mode,
    transport=urllib_transport,
    api_url="https://api.github.com",
):
    result = _base_result(repository, mode)
    if mode not in ("plan", "apply"):
        return _blocked(result, "invalid_mode", "mode must be plan or apply")
    if not isinstance(repository, str) or REPOSITORY_PATTERN.fullmatch(repository) is None:
        return _blocked(result, "invalid_repository", "repository must be owner/name")
    if not isinstance(token, str) or not token:
        return _blocked(result, "missing_token", "GitHub token is required")

    main_response = _request(
        transport, "GET", _ref_url(api_url, repository, "main"), token,
    )
    if main_response.status == 404:
        return _blocked(result, "main_missing", "refs/heads/main does not exist", 404)
    if main_response.status != 200:
        return _blocked(
            result,
            "main_lookup_failed",
            _response_message(main_response, token),
            main_response.status,
        )
    main_sha = _parse_ref(main_response.payload, MAIN_REF)
    if main_sha is None:
        return _blocked(result, "malformed_main_ref", "GitHub returned an invalid main ref")
    result["main"] = {"ref": MAIN_REF, "exists": True, "sha": main_sha}

    stage_response = _request(
        transport, "GET", _ref_url(api_url, repository, "stage"), token,
    )
    if stage_response.status == 200:
        stage_sha = _parse_ref(stage_response.payload, STAGE_REF)
        if stage_sha is None:
            return _blocked(result, "malformed_stage_ref", "GitHub returned an invalid stage ref")
        result["stage"] = {"ref": STAGE_REF, "exists": True, "sha": stage_sha}
        result["status"] = "noop"
        return result
    if stage_response.status != 404:
        return _blocked(
            result,
            "stage_lookup_failed",
            _response_message(stage_response, token),
            stage_response.status,
        )

    action = {"operation": "create", "ref": STAGE_REF, "sha": main_sha}
    result["actions"] = [action]
    if mode == "plan":
        result["status"] = "ready"
        return result

    create_response = _request(
        transport,
        "POST",
        _refs_url(api_url, repository),
        token,
        {"ref": STAGE_REF, "sha": main_sha},
    )
    if create_response.status != 201:
        return _blocked(
            result,
            "stage_creation_blocked",
            _response_message(create_response, token),
            create_response.status,
        )
    created_sha = _parse_ref(create_response.payload, STAGE_REF)
    if created_sha != main_sha:
        return _blocked(
            result,
            "malformed_created_stage_ref",
            "GitHub returned an invalid created stage ref",
        )
    result["stage"] = {"ref": STAGE_REF, "exists": True, "sha": created_sha}
    result["status"] = "created"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("repository")
    parser.add_argument("mode", choices=("plan", "apply"))
    parser.add_argument("--api-url", default="https://api.github.com")
    parser.add_argument("--token-env", default="GITHUB_TOKEN")
    args = parser.parse_args(argv)
    token = os.environ.get(args.token_env, "")
    result = bootstrap_repository_branches(
        repository=args.repository,
        token=token,
        mode=args.mode,
        api_url=args.api_url,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 2 if result["status"] == "blocked" else 0


if __name__ == "__main__":
    sys.exit(main())
