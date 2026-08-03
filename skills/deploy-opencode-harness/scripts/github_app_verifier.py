#!/usr/bin/env python3
"""Verify a repository-scoped GitHub Release App without exposing credentials."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping, TextIO


API_VERSION = "2022-11-28"
DEFAULT_API_URL = "https://api.github.com"
REQUIRED_PERMISSIONS = {
    "metadata": "read",
    "contents": "write",
    "issues": "write",
    "pull_requests": "write",
    "checks": "read",
}
REDACTED_FIELDS = [
    "app_id",
    "private_key",
    "app_jwt",
    "installation_token",
]


class VerificationError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        details: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


class HttpResponse:
    def __init__(self, status: int, headers: Mapping[str, str], body: bytes) -> None:
        self.status = status
        self.headers = dict(headers)
        self.body = body


class UrllibTransport:
    def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None = None,
    ) -> HttpResponse:
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return HttpResponse(
                    status=response.status,
                    headers=dict(response.headers.items()),
                    body=response.read(),
                )
        except urllib.error.HTTPError as error:
            return HttpResponse(
                status=error.code,
                headers=dict(error.headers.items()) if error.headers else {},
                body=error.read(),
            )


class _DerReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    def read(self, expected_tag: int) -> bytes:
        if self.offset >= len(self.data) or self.data[self.offset] != expected_tag:
            raise ValueError("unexpected DER tag")
        self.offset += 1
        length = self._read_length()
        end = self.offset + length
        if end > len(self.data):
            raise ValueError("truncated DER value")
        value = self.data[self.offset:end]
        self.offset = end
        return value

    def _read_length(self) -> int:
        if self.offset >= len(self.data):
            raise ValueError("missing DER length")
        first = self.data[self.offset]
        self.offset += 1
        if first < 0x80:
            return first
        width = first & 0x7F
        if width == 0 or width > 4 or self.offset + width > len(self.data):
            raise ValueError("invalid DER length")
        length = int.from_bytes(self.data[self.offset : self.offset + width], "big")
        self.offset += width
        return length

    def exhausted(self) -> bool:
        return self.offset == len(self.data)


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_pem(private_key: bytes) -> tuple[str, bytes]:
    try:
        text = private_key.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise ValueError("private key is not ASCII PEM") from error

    labels = ("PRIVATE KEY", "RSA PRIVATE KEY")
    for label in labels:
        begin = f"-----BEGIN {label}-----"
        end = f"-----END {label}-----"
        if not text.startswith(begin) or not text.endswith(end):
            continue
        encoded = "".join(text[len(begin) : -len(end)].split())
        try:
            return label, base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error) as error:
            raise ValueError("invalid PEM encoding") from error
    raise ValueError("unsupported PEM envelope")


def _read_integer(reader: _DerReader) -> int:
    raw = reader.read(0x02)
    if not raw or raw[0] & 0x80:
        raise ValueError("invalid DER integer")
    return int.from_bytes(raw, "big")


def _parse_pkcs1(der: bytes) -> tuple[int, int]:
    outer = _DerReader(der)
    sequence = _DerReader(outer.read(0x30))
    if not outer.exhausted() or _read_integer(sequence) not in (0, 1):
        raise ValueError("invalid RSA private key")
    modulus = _read_integer(sequence)
    public_exponent = _read_integer(sequence)
    private_exponent = _read_integer(sequence)
    if modulus.bit_length() < 512 or public_exponent < 3 or private_exponent < 3:
        raise ValueError("invalid RSA private key")
    return modulus, private_exponent


def _parse_private_key(private_key: bytes) -> tuple[int, int]:
    label, der = _decode_pem(private_key)
    if label == "RSA PRIVATE KEY":
        return _parse_pkcs1(der)

    outer = _DerReader(der)
    sequence = _DerReader(outer.read(0x30))
    if not outer.exhausted() or _read_integer(sequence) != 0:
        raise ValueError("invalid PKCS#8 private key")
    algorithm = _DerReader(sequence.read(0x30))
    rsa_oid = bytes.fromhex("2a864886f70d010101")
    if algorithm.read(0x06) != rsa_oid:
        raise ValueError("private key is not RSA")
    if not algorithm.exhausted():
        algorithm.read(0x05)
    if not algorithm.exhausted():
        raise ValueError("invalid PKCS#8 algorithm identifier")
    return _parse_pkcs1(sequence.read(0x04))


def _sign_rs256(signing_input: bytes, modulus: int, private_exponent: int) -> bytes:
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420")
    digest_info += hashlib.sha256(signing_input).digest()
    width = (modulus.bit_length() + 7) // 8
    padding_width = width - len(digest_info) - 3
    if padding_width < 8:
        raise ValueError("RSA private key is too small")
    encoded = b"\x00\x01" + (b"\xff" * padding_width) + b"\x00" + digest_info
    signature = pow(int.from_bytes(encoded, "big"), private_exponent, modulus)
    return signature.to_bytes(width, "big")


def _create_app_jwt(app_id: str, private_key: bytes, now: int) -> str:
    modulus, private_exponent = _parse_private_key(private_key)
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64url(
        json.dumps(
            {"iat": now - 60, "exp": now + 540, "iss": app_id},
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode("ascii")
    return f"{header}.{payload}.{_b64url(_sign_rs256(signing_input, modulus, private_exponent))}"


def _decode_json(response: HttpResponse) -> Any:
    try:
        return json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError("invalid_github_response", "GitHub returned invalid JSON") from error


def _request_json(
    transport: Any,
    method: str,
    url: str,
    authorization: str,
    body: Mapping[str, Any] | None = None,
) -> tuple[int, Any]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": authorization,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "opencode-harness-release-app-verifier",
    }
    encoded_body = None
    if body is not None:
        encoded_body = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        response = transport.request(method, url, headers, encoded_body)
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        raise VerificationError("github_api_unavailable", "GitHub API request failed") from error
    return response.status, _decode_json(response)


def _read_private_key(path: Path) -> bytes:
    try:
        private_key = path.read_bytes()
        _parse_private_key(private_key)
        return private_key
    except (OSError, ValueError) as error:
        raise VerificationError("invalid_private_key", "GitHub App private key is invalid") from error


def _validate_app_id(app_id: str) -> int:
    try:
        parsed = int(app_id)
    except (TypeError, ValueError) as error:
        raise VerificationError("invalid_app_id", "GitHub App ID is invalid") from error
    if parsed <= 0:
        raise VerificationError("invalid_app_id", "GitHub App ID is invalid")
    return parsed


def _list_installations(
    transport: Any,
    api_url: str,
    app_authorization: str,
) -> list[Mapping[str, Any]]:
    installations: list[Mapping[str, Any]] = []
    page = 1
    while True:
        status, payload = _request_json(
            transport,
            "GET",
            f"{api_url}/app/installations?per_page=100&page={page}",
            app_authorization,
        )
        if status != 200 or not isinstance(payload, list):
            raise VerificationError("installation_lookup_failed", "GitHub App installations could not be read")
        installations.extend(item for item in payload if isinstance(item, Mapping))
        if len(payload) < 100:
            return installations
        page += 1


def _list_repositories(
    transport: Any,
    api_url: str,
    installation_authorization: str,
) -> list[str]:
    repositories: list[str] = []
    page = 1
    while True:
        status, payload = _request_json(
            transport,
            "GET",
            f"{api_url}/installation/repositories?per_page=100&page={page}",
            installation_authorization,
        )
        if status != 200 or not isinstance(payload, Mapping):
            raise VerificationError("repository_lookup_failed", "Installation repositories could not be read")
        page_repositories = payload.get("repositories")
        if not isinstance(page_repositories, list):
            raise VerificationError("invalid_github_response", "GitHub returned invalid repository data")
        for repository in page_repositories:
            if not isinstance(repository, Mapping) or not isinstance(repository.get("full_name"), str):
                raise VerificationError("invalid_github_response", "GitHub returned invalid repository data")
            repositories.append(repository["full_name"])
        if len(page_repositories) < 100:
            return repositories
        page += 1


def _validate_permissions(permissions: Any) -> dict[str, str]:
    if not isinstance(permissions, Mapping):
        raise VerificationError("permission_mismatch", "GitHub App permissions do not match the required policy")
    for permission, required in REQUIRED_PERMISSIONS.items():
        if permissions.get(permission) != required:
            raise VerificationError(
                "permission_mismatch",
                "GitHub App permissions do not match the required policy",
                {"permission": permission, "required": required},
            )
    administration = permissions.get("administration", "none")
    if administration not in (None, "none"):
        raise VerificationError(
            "excessive_permission",
            "GitHub App administration permission must be disabled",
            {"permission": "administration", "required": "none"},
        )
    return {**REQUIRED_PERMISSIONS, "administration": "none"}


def verify_github_release_app(
    *,
    app_id: str,
    private_key_path: str | Path,
    expected_repository: str,
    transport: Any | None = None,
    now: Callable[[], int | float] = time.time,
    api_url: str = DEFAULT_API_URL,
) -> dict[str, Any]:
    parsed_app_id = _validate_app_id(app_id)
    if expected_repository.count("/") != 1:
        raise VerificationError("invalid_repository", "Expected repository must be owner/name")
    expected_owner, expected_name = expected_repository.split("/", 1)
    if not expected_owner or not expected_name:
        raise VerificationError("invalid_repository", "Expected repository must be owner/name")

    private_key = _read_private_key(Path(private_key_path))
    try:
        app_jwt = _create_app_jwt(str(parsed_app_id), private_key, int(now()))
    except ValueError as error:
        raise VerificationError("invalid_private_key", "GitHub App private key is invalid") from error
    client = transport or UrllibTransport()
    base_url = api_url.rstrip("/")
    app_authorization = f"Bearer {app_jwt}"

    status, app = _request_json(client, "GET", f"{base_url}/app", app_authorization)
    if status != 200 or not isinstance(app, Mapping) or app.get("id") != parsed_app_id:
        raise VerificationError("github_app_auth_failed", "GitHub App authentication failed")

    installations = _list_installations(client, base_url, app_authorization)
    matching_installations = [
        installation
        for installation in installations
        if isinstance(installation.get("account"), Mapping)
        and str(installation["account"].get("login", "")).casefold() == expected_owner.casefold()
    ]
    if not matching_installations:
        raise VerificationError("installation_not_found", "No GitHub App installation matched the repository owner")
    if len(matching_installations) != 1:
        raise VerificationError("installation_ambiguous", "Multiple GitHub App installations matched the repository owner")

    installation = matching_installations[0]
    installation_id = installation.get("id")
    if not isinstance(installation_id, int) or installation_id <= 0:
        raise VerificationError("invalid_github_response", "GitHub returned an invalid installation")
    status, token_payload = _request_json(
        client,
        "POST",
        f"{base_url}/app/installations/{installation_id}/access_tokens",
        app_authorization,
        {},
    )
    if status != 201 or not isinstance(token_payload, Mapping):
        raise VerificationError("installation_token_failed", "GitHub installation token could not be issued")
    installation_token = token_payload.get("token")
    if not isinstance(installation_token, str) or not installation_token:
        raise VerificationError("invalid_github_response", "GitHub returned an invalid installation token")

    permissions = _validate_permissions(token_payload.get("permissions"))
    repository_selection = token_payload.get("repository_selection")
    repositories = _list_repositories(client, base_url, f"Bearer {installation_token}")
    expected_normalized = expected_repository.casefold()
    actual_normalized = {repository.casefold() for repository in repositories}
    if repository_selection != "selected" or actual_normalized != {expected_normalized}:
        raise VerificationError(
            "repository_scope_mismatch",
            "GitHub App installation repository scope does not match the expected repository",
        )

    return {
        "ok": True,
        "github_app": {
            "authenticated": True,
            "installation": {
                "resolved": True,
                "id": installation_id,
                "account": expected_owner,
            },
            "repository_scope": {
                "selection": "selected",
                "repositories": [expected_repository],
            },
            "permissions": permissions,
        },
        "redacted": list(REDACTED_FIELDS),
    }


def emit_json(report: Mapping[str, Any], output: TextIO) -> None:
    json.dump(report, output, sort_keys=True, separators=(",", ":"))
    output.write("\n")


def _error_report(error: VerificationError) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": False,
        "error": {"code": error.code, "message": str(error)},
        "redacted": list(REDACTED_FIELDS),
    }
    if error.details:
        report["error"]["details"] = error.details
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--api-url", default=DEFAULT_API_URL)
    return parser


def main(argv: list[str] | None = None, output: TextIO | None = None) -> int:
    args = build_parser().parse_args(argv)
    stream = output
    if stream is None:
        import sys

        stream = sys.stdout
    try:
        report = verify_github_release_app(
            app_id=args.app_id,
            private_key_path=args.private_key,
            expected_repository=args.repository,
            api_url=args.api_url,
        )
    except VerificationError as error:
        emit_json(_error_report(error), stream)
        return 1
    emit_json(report, stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
