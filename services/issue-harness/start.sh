#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${HARNESS_DATA_DIR:-/data}/sandcastle" "${HARNESS_DATA_DIR:-/data}/codex" "${HARNESS_DATA_DIR:-/data}/state"

if command -v docker >/dev/null 2>&1; then
  docker build -f .sandcastle/Dockerfile -t "${SANDCASTLE_IMAGE:-sandcastle-harness:latest}" .
fi

exec npm run start -w services/issue-harness
