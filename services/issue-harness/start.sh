#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/runtime_permissions.sh"
source "$script_dir/github_app_secret.sh"

data_dir="${HARNESS_DATA_DIR:-/opt/issue-harness/default}"
resolved_data_dir="$(realpath -m "$data_dir")"
if [[ "$data_dir" != "$resolved_data_dir" || "$resolved_data_dir" != /opt/issue-harness/* ]]; then
  echo "HARNESS_DATA_DIR must be a non-symlinked per-repository child of /opt/issue-harness" >&2
  exit 1
fi
harden_harness_runtime "$data_dir"
umask 0007

exec {harness_lock_fd}>"$data_dir/process.lock"
chmod 600 "$data_dir/process.lock"
if ! flock -n "$harness_lock_fd"; then
  echo "Another issue-harness process already owns HARNESS_DATA_DIR" >&2
  exit 1
fi

prepare_github_app_private_key
trap cleanup_github_app_private_key EXIT

npm run start -w services/issue-harness &
worker_pid=$!

stop_worker() {
  trap - TERM INT
  kill -TERM "$worker_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  exit 143
}
trap stop_worker TERM INT

wait "$worker_pid"
