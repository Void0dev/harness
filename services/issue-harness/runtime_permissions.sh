#!/usr/bin/env bash

harden_harness_runtime() {
  if [[ "$#" -ne 1 ]]; then
    echo "usage: harden_harness_runtime DATA_DIR" >&2
    return 2
  fi

  local data_dir="$1"
  local runtime_names=(
    logs
    state
    runs
    artifacts
    publishers
    context
  )
  local runtime_paths=()
  local name
  local runtime_path

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
}
