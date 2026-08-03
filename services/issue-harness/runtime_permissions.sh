#!/usr/bin/env bash

harden_harness_runtime() {
  if [[ "$#" -ne 1 ]]; then
    echo "usage: harden_harness_runtime DATA_DIR" >&2
    return 2
  fi

  local data_dir="$1"
  local private_names=(
    state
  )
  local shared_names=(
    context
    runs
  )
  local private_paths=()
  local shared_paths=()
  local name
  local runtime_path

  if [[ -L "$data_dir" ]]; then
    echo "Refusing symbolic-link harness data directory" >&2
    return 1
  fi
  mkdir -p -- "$data_dir"

  for name in "${private_names[@]}"; do
    runtime_path="$data_dir/$name"
    if [[ -L "$runtime_path" ]]; then
      echo "Refusing symbolic-link runtime directory: $name" >&2
      return 1
    fi
    mkdir -p -- "$runtime_path"
    private_paths+=("$runtime_path")
  done

  for name in "${shared_names[@]}"; do
    runtime_path="$data_dir/$name"
    if [[ -L "$runtime_path" ]]; then
      echo "Refusing symbolic-link runtime directory: $name" >&2
      return 1
    fi
    mkdir -p -- "$runtime_path"
    shared_paths+=("$runtime_path")
  done

  chmod 0700 "$data_dir" "${private_paths[@]}"
  chmod 2770 "${shared_paths[@]}"
}
