#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/runtime_permissions.sh"

data_dir="${HARNESS_DATA_DIR:-/opt/issue-harness/default}"
resolved_data_dir="$(realpath -m "$data_dir")"
if [[ "$data_dir" != "$resolved_data_dir" || "$resolved_data_dir" != /opt/issue-harness/* ]]; then
  echo "HARNESS_DATA_DIR must be a non-symlinked per-repository child of /opt/issue-harness" >&2
  exit 1
fi
harden_harness_runtime "$data_dir" "10001:10001"

exec {harness_lock_fd}>"$data_dir/process.lock"
chmod 600 "$data_dir/process.lock"
if ! flock -n "$harness_lock_fd"; then
  echo "Another issue-harness process already owns HARNESS_DATA_DIR" >&2
  exit 1
fi

exec gosu agent npm run start -w services/issue-harness
