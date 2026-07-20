#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/runtime_permissions.sh"
source "$script_dir/verify_runtime.sh"

registry_server=""
registry_logged_in="false"
cleanup_registry_login() {
  if [[ "$registry_logged_in" == "true" ]]; then
    docker logout "$registry_server" >/dev/null 2>&1 || true
  fi
}
trap cleanup_registry_login EXIT

data_dir="${HARNESS_DATA_DIR:-/opt/issue-harness/default}"
resolved_data_dir="$(realpath -m "$data_dir")"
if [[ "$data_dir" != "$resolved_data_dir" || "$resolved_data_dir" != /opt/issue-harness/* ]]; then
  echo "HARNESS_DATA_DIR must be a non-symlinked per-repository child of /opt/issue-harness" >&2
  exit 1
fi
harden_harness_runtime "$data_dir" "10001:10001"

for legacy_credentials in "$data_dir/auth" "$data_dir/codex"; do
  if [[ -e "$legacy_credentials" || -L "$legacy_credentials" ]]; then
    echo "Refusing legacy persistent Codex credential directory: $legacy_credentials" >&2
    exit 1
  fi
done

exec {harness_lock_fd}>"$data_dir/process.lock"
chmod 600 "$data_dir/process.lock"
if ! flock -n "$harness_lock_fd"; then
  echo "Another issue-harness process already owns HARNESS_DATA_DIR" >&2
  exit 1
fi

verify_sandbox_docker_daemon "$data_dir"

docker_host="${DOCKER_HOST:-}"
socket_path="${SANDBOX_DOCKER_SOCKET_PATH:-/run/sandbox-engine/docker.sock}"
if [[ "$docker_host" == "unix://$socket_path" ]]; then
  socket_gid="$(stat -c '%g' "$socket_path")"
  socket_group="$(getent group "$socket_gid" | cut -d: -f1 || true)"
  if [[ -z "$socket_group" ]]; then
    socket_group="docker-host"
    groupadd --gid "$socket_gid" "$socket_group"
  fi
  usermod -aG "$socket_group" agent
fi

if command -v docker >/dev/null 2>&1; then
  sandbox_image="${SANDCASTLE_IMAGE:-sandcastle-harness:0.1.0}"
  if [[ "${REQUIRE_PINNED_IMAGES:-false}" == "true" ]] \
    && [[ ! "$sandbox_image" =~ ^ghcr\.io/void0dev/sandcastle-harness@sha256:[0-9a-f]{64}$ ]]; then
    echo "SANDCASTLE_IMAGE must use the canonical image coordinate and lowercase sha256 digest" >&2
    exit 1
  fi
  registry_server="${SANDBOX_REGISTRY_SERVER:-}"
  if [[ -n "${SANDBOX_REGISTRY_TOKEN:-}" ]]; then
    if [[ -z "$registry_server" || -z "${SANDBOX_REGISTRY_USERNAME:-}" ]]; then
      echo "SANDBOX_REGISTRY_SERVER and SANDBOX_REGISTRY_USERNAME are required with SANDBOX_REGISTRY_TOKEN" >&2
      exit 1
    fi
    printf '%s' "$SANDBOX_REGISTRY_TOKEN" | docker login "$registry_server" --username "$SANDBOX_REGISTRY_USERNAME" --password-stdin >/dev/null
    registry_logged_in="true"
  fi
  if [[ "$sandbox_image" == *@sha256:* ]]; then
    docker image inspect "$sandbox_image" >/dev/null 2>&1 || docker pull "$sandbox_image"
  elif [[ "${SANDCASTLE_BUILD_LOCAL:-true}" == "true" ]]; then
    docker build -f .sandcastle/Dockerfile -t "$sandbox_image" .
  else
    docker image inspect "$sandbox_image" >/dev/null 2>&1 || docker pull "$sandbox_image"
  fi
  if [[ -n "${SANDBOX_REGISTRY_TOKEN:-}" ]]; then
    cleanup_registry_login
    registry_logged_in="false"
  fi
fi

trap - EXIT
unset SANDBOX_REGISTRY_TOKEN
exec gosu agent npm run start -w services/issue-harness
