#!/usr/bin/env bash
set -euo pipefail

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
mkdir -p "$data_dir/sandcastle" "$data_dir/codex" "$data_dir/state" "$data_dir/workspaces"
chown 10001:10001 "$data_dir" "$data_dir/sandcastle" "$data_dir/codex" "$data_dir/state" "$data_dir/workspaces"

if [[ -S /var/run/docker.sock ]]; then
  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
  socket_group="$(getent group "$socket_gid" | cut -d: -f1 || true)"
  if [[ -z "$socket_group" ]]; then
    socket_group="docker-host"
    groupadd --gid "$socket_gid" "$socket_group"
  fi
  usermod -aG "$socket_group" agent
fi

if command -v docker >/dev/null 2>&1; then
  sandbox_image="${SANDCASTLE_IMAGE:-sandcastle-harness:0.1.0}"
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
