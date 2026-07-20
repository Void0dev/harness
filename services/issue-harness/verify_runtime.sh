#!/usr/bin/env bash

verify_sandbox_docker_daemon() {
  local data_dir="$1"
  local docker_host="${DOCKER_HOST:-}"
  local socket_path="${SANDBOX_DOCKER_SOCKET_PATH:-/run/sandbox-engine/docker.sock}"

  if [[ "$docker_host" == "unix://$socket_path" ]]; then
    if [[ ! -S "$socket_path" ]]; then
      echo "DOCKER_HOST points to a missing dedicated rootless socket" >&2
      return 1
    fi
    local expected_id="${SANDBOX_DOCKER_DAEMON_ID:-}"
    if [[ -z "$expected_id" ]]; then
      echo "SANDBOX_DOCKER_DAEMON_ID is required for local daemon attestation" >&2
      return 1
    fi
    local actual_id security_options
    actual_id="$(docker info --format '{{.ID}}')"
    security_options="$(docker info --format '{{json .SecurityOptions}}')"
    if [[ -z "$actual_id" || "$actual_id" != "$expected_id" ]]; then
      echo "Connected Docker daemon identity does not match SANDBOX_DOCKER_DAEMON_ID" >&2
      return 1
    fi
    if [[ "$security_options" != *'name=rootless'* ]]; then
      echo "Connected local Docker daemon does not attest rootless SecurityOptions" >&2
      return 1
    fi
    return 0
  fi

  if [[ "$docker_host" == tcp://* ]]; then
    if [[ "${DOCKER_TLS_VERIFY:-}" != "1" ]]; then
      echo "Remote Docker requires DOCKER_TLS_VERIFY=1" >&2
      return 1
    fi
    local cert_path="${DOCKER_CERT_PATH:-}"
    if [[ "$cert_path" != "$data_dir/docker-certs" ]]; then
      echo "DOCKER_CERT_PATH must be HARNESS_DATA_DIR/docker-certs" >&2
      return 1
    fi
    local certificate
    for certificate in ca.pem cert.pem key.pem; do
      if [[ ! -f "$cert_path/$certificate" || -L "$cert_path/$certificate" ]]; then
        echo "Missing remote Docker TLS file: $certificate" >&2
        return 1
      fi
    done
    return 0
  fi

  echo "DOCKER_HOST must select the dedicated rootless socket or a remote tcp:// TLS daemon" >&2
  return 1
}
