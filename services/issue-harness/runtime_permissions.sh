#!/usr/bin/env bash

harden_harness_runtime() {
  if [[ "$#" -ne 2 ]]; then
    echo "usage: harden_harness_runtime DATA_DIR OWNER" >&2
    return 2
  fi

  local data_dir="$1"
  local owner="$2"
  local runtime_names=(
    logs
    state
    sandboxes
    workspaces
    sandcastle
    runs
    artifacts
    publishers
    docker-certs
  )
  local runtime_paths=()
  local name
  local runtime_path
  local certificate

  if [[ -L "$data_dir" ]]; then
    echo "Refusing symbolic-link harness data directory" >&2
    return 1
  fi
  mkdir -p -- "$data_dir"

  for name in "${runtime_names[@]}"; do
    runtime_path="$data_dir/$name"
    if [[ -L "$runtime_path" ]]; then
      echo "Refusing symbolic-link runtime directory: $name" >&2
      return 1
    fi
    mkdir -p -- "$runtime_path"
    runtime_paths+=("$runtime_path")
  done

  chmod 0700 "$data_dir" "${runtime_paths[@]}"
  chown "$owner" "$data_dir" "${runtime_paths[@]}"

  for certificate in "$data_dir/docker-certs"/*; do
    if [[ -L "$certificate" ]]; then
      echo "Refusing symbolic-link Docker TLS certificate" >&2
      return 1
    fi
  done

  while IFS= read -r -d '' certificate; do
    chmod 0600 "$certificate"
    chown "$owner" "$certificate"
  done < <(find "$data_dir/docker-certs" -maxdepth 1 -type f -print0)
}
