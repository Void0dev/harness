"""Fail-closed HTTP transport and non-secret access-policy evidence for Coolify."""

from __future__ import annotations

import datetime
import ipaddress
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_RESPONSE_BYTES = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 30
POLICY_FIELDS = {"purpose", "scopes", "expiresAt", "ipAllowlisted"}
PURPOSE_SCOPES = {
    "reconcile": {"read", "write"},
    "verify": {"read"},
    "pin": {"read", "write"},
    "deploy": {"read", "deploy"},
}
SAFE_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
STATIC_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AccessPolicy:
    def __init__(self, purpose: str, scopes: set[str], expires_at: datetime.datetime):
        self.purpose = purpose
        self.scopes = frozenset(scopes)
        self.expires_at = expires_at
        self.ip_allowlisted = True

    @classmethod
    def from_mapping(cls, payload: object, *, now: datetime.datetime | None = None):
        if not isinstance(payload, dict) or set(payload) != POLICY_FIELDS:
            raise ValueError("Coolify access policy must contain only purpose, scopes, expiresAt, and ipAllowlisted")
        purpose = payload.get("purpose")
        expected_scopes = PURPOSE_SCOPES.get(purpose)
        scopes = payload.get("scopes")
        if expected_scopes is None or not isinstance(scopes, list) or set(scopes) != expected_scopes or len(scopes) != len(expected_scopes):
            raise ValueError("Coolify access policy scopes must be the exact least-privilege set for its purpose")
        if payload.get("ipAllowlisted") is not True:
            raise ValueError("Coolify token must be restricted by an IP allowlist")
        raw_expiry = payload.get("expiresAt")
        if not isinstance(raw_expiry, str):
            raise ValueError("Coolify token expiresAt must be a timezone-aware ISO-8601 timestamp")
        try:
            expires_at = datetime.datetime.fromisoformat(raw_expiry.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("Coolify token expiresAt must be a timezone-aware ISO-8601 timestamp") from None
        if expires_at.tzinfo is None:
            raise ValueError("Coolify token expiresAt must be a timezone-aware ISO-8601 timestamp")
        current = now or datetime.datetime.now(datetime.timezone.utc)
        remaining = expires_at.astimezone(datetime.timezone.utc) - current.astimezone(datetime.timezone.utc)
        if remaining <= datetime.timedelta(0):
            raise ValueError("Coolify token is expired")
        if remaining > datetime.timedelta(hours=24):
            raise ValueError("Coolify token expiry must be within 24 hours")
        return cls(purpose, expected_scopes, expires_at)

    @classmethod
    def from_environment(
        cls,
        purpose: str,
        environment: dict[str, str],
        *,
        prefix: str = "COOLIFY_TOKEN",
    ):
        raw_scopes = environment.get(f"{prefix}_SCOPES", "")
        return cls.from_mapping({
            "purpose": purpose,
            "scopes": [scope.strip() for scope in raw_scopes.split(",") if scope.strip()],
            "expiresAt": environment.get(f"{prefix}_EXPIRES_AT"),
            "ipAllowlisted": environment.get(f"{prefix}_IP_ALLOWLISTED", "").lower() == "true",
        })

    def assert_current(self) -> None:
        if self.expires_at <= datetime.datetime.now(datetime.timezone.utc):
            raise ValueError("Coolify token is expired")

    def evidence(self) -> dict:
        return {
            "purpose": self.purpose,
            "scopes": sorted(self.scopes),
            "expiresAt": self.expires_at.isoformat(),
            "ipAllowlisted": self.ip_allowlisted,
            "evidenceSource": "operator-assertion",
        }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def _is_loopback(hostname: str | None) -> bool:
    if hostname == "localhost":
        return True
    try:
        return bool(hostname and ipaddress.ip_address(hostname).is_loopback)
    except ValueError:
        return False


class CoolifyClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        access_policy: AccessPolicy,
        *,
        allow_insecure_loopback: bool = False,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
        timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
    ):
        if not isinstance(base_url, str):
            raise ValueError("Coolify URL must be a string")
        parsed = urllib.parse.urlsplit(base_url)
        insecure_loopback = (
            allow_insecure_loopback and parsed.scheme == "http" and _is_loopback(parsed.hostname)
        )
        if parsed.scheme != "https" and not insecure_loopback:
            raise ValueError("Coolify URL must use HTTPS")
        if not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError("Coolify URL must not contain userinfo and must have a hostname")
        if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Coolify URL must be an origin without path, query, or fragment")
        if not isinstance(token, str) or not token or len(token) > 4096 or any(character.isspace() or ord(character) < 32 for character in token):
            raise ValueError("Coolify token must be a bounded bearer token without whitespace")
        if not isinstance(access_policy, AccessPolicy):
            raise ValueError("Coolify access policy evidence is required")
        if not isinstance(max_response_bytes, int) or not 1 <= max_response_bytes <= MAX_RESPONSE_BYTES:
            raise ValueError("Coolify response limit must be between 1 byte and 1 MiB")
        if not isinstance(timeout_seconds, (int, float)) or not 0 < timeout_seconds <= REQUEST_TIMEOUT_SECONDS:
            raise ValueError("Coolify timeout must be greater than 0 and at most 30 seconds")

        origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        self.base_url = origin + "/api/v1"
        self.token = token
        self.access_policy = access_policy
        self.max_response_bytes = max_response_bytes
        self.timeout_seconds = timeout_seconds
        self.proxy_handler = urllib.request.ProxyHandler({})
        handlers = [self.proxy_handler, NoRedirect()]
        if parsed.scheme == "https":
            handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        self.opener = urllib.request.build_opener(*handlers)

    @staticmethod
    def literal_path(*segments: str) -> str:
        if not segments:
            raise ValueError("Coolify API path requires at least one literal segment")
        for segment in segments:
            if not isinstance(segment, str) or not SAFE_PATH_SEGMENT.fullmatch(segment):
                raise ValueError("Coolify API path segments must be bounded literal identifiers")
        return "/" + "/".join(urllib.parse.quote(segment, safe="") for segment in segments)

    @staticmethod
    def _validate_path(path: object) -> str:
        if not isinstance(path, str) or not path.startswith("/") or len(path) > 1024:
            raise ValueError("Coolify API path must be a bounded origin-relative literal")
        if any(token in path for token in ("\\", "%", "?", "#", "//")):
            raise ValueError("Coolify API path contains normalization ambiguity")
        segments = path[1:].split("/")
        if not segments or any(
            segment in ("", ".", "..")
            or not (SAFE_PATH_SEGMENT.fullmatch(segment) or STATIC_PATH_SEGMENT.fullmatch(segment))
            for segment in segments
        ):
            raise ValueError("Coolify API path must contain only literal path segments")
        canonical = "/" + "/".join(urllib.parse.quote(segment, safe="") for segment in segments)
        if canonical != path:
            raise ValueError("Coolify API path is not canonically encoded")
        return canonical

    def _read_bounded(self, response, limit: int | None = None) -> bytes:
        effective_limit = self.max_response_bytes if limit is None else min(limit, self.max_response_bytes)
        content_length = response.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > effective_limit:
                    raise RuntimeError("Coolify response exceeds the configured byte limit")
            except ValueError:
                raise RuntimeError("Coolify returned an invalid content-length") from None
        raw = response.read(effective_limit + 1)
        if len(raw) > effective_limit:
            raise RuntimeError("Coolify response exceeds the configured byte limit")
        return raw

    def _open(self, method: str, path: str, body=None):
        if method not in {"GET", "POST", "PATCH"}:
            raise ValueError("unsupported Coolify HTTP method")
        path = self._validate_path(path)
        self.access_policy.assert_current()
        if method == "GET":
            required_scope = "read"
        elif method == "POST" and path == "/deploy":
            required_scope = "deploy"
        else:
            required_scope = "write"
        if required_scope not in self.access_policy.scopes:
            raise ValueError(f"Coolify access policy lacks required {required_scope} scope")
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "project-harness/1",
            },
        )
        try:
            return self.opener.open(request, timeout=self.timeout_seconds)
        except urllib.error.HTTPError as exc:
            try:
                self._read_bounded(exc)
            except RuntimeError:
                pass
            if 300 <= exc.code < 400:
                raise RuntimeError(f"Coolify {method} {path} redirects are denied") from None
            raise RuntimeError(
                f"Coolify {method} {path} failed with HTTP {exc.code}; response body withheld because it may contain secrets"
            ) from None
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Coolify {method} {path} transport failed: {type(exc.reason).__name__}") from None

    def request(self, method: str, path: str, body=None):
        with self._open(method, path, body) as response:
            raw = self._read_bounded(response)
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError("Coolify returned invalid JSON; response body withheld") from None

    def request_text(self, method: str, path: str, *, limit: int = 128) -> str:
        with self._open(method, path) as response:
            return self._read_bounded(response, limit).decode(errors="replace").strip()

    def version(self) -> str:
        return self.request_text("GET", "/version", limit=128)


def probe_https_health(url: str, *, attempts: int = 12, sleep=time.sleep) -> None:
    if not isinstance(url, str):
        raise ValueError("health URL must be a string")
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise ValueError("health URL must be an HTTPS URL without userinfo, query, or fragment")
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    last_error = "unavailable"
    for _attempt in range(attempts):
        request = urllib.request.Request(
            url,
            method="GET",
            headers={"Accept": "application/json", "User-Agent": "project-harness/1"},
        )
        try:
            with opener.open(request, timeout=15) as response:
                content_length = response.headers.get("content-length")
                if content_length is not None and int(content_length) > 4096:
                    raise RuntimeError("health response exceeds 4096 bytes")
                if len(response.read(4097)) > 4096:
                    raise RuntimeError("health response exceeds 4096 bytes")
                if 200 <= response.status < 300:
                    return
                last_error = f"HTTP {response.status}"
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise RuntimeError("health redirects are denied") from None
            last_error = f"HTTP {exc.code}"
        except urllib.error.URLError as exc:
            last_error = type(exc.reason).__name__
        sleep(10)
    raise RuntimeError(f"health probe failed after exact deployment: {last_error}")
