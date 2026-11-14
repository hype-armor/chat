#!/usr/bin/env bash
# Build images one at a time. Give each Cargo build the host's CPU budget.
# Usage: scripts/compose-build.sh [service ...] (defaults: server web echo-invite echo)
# Override with a positive CARGO_BUILD_JOBS value when a smaller budget is needed.
# This command builds images only. It does not restart containers.
set -euo pipefail
cd "$(dirname "$0")/.."

jobs="${CARGO_BUILD_JOBS:-}"
if [[ -z "$jobs" ]]; then
  if command -v nproc >/dev/null 2>&1; then
    jobs="$(nproc)"
  else
    jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')"
  fi
fi
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  printf 'CARGO_BUILD_JOBS must be a positive integer (got %s)\n' "$jobs" >&2
  exit 2
fi

if [[ "$#" -eq 0 ]]; then set -- server web echo-invite echo; fi
# Validate all names before starting any build. Flags belong to the script, not Docker.
for service in "$@"; do
  if [[ ! "$service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
    printf 'Invalid Compose service name: %s\n' "$service" >&2
    exit 2
  fi
done

for service in "$@"; do
  printf 'Building %s with %s Cargo job(s); image builds are sequential.\n' "$service" "$jobs"
  if [[ "$service" == bots ]]; then
    docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.bots.yml \
      --profile echo --profile bots build --build-arg "CARGO_BUILD_JOBS=$jobs" "$service"
  else
    docker compose -f deploy/compose/docker-compose.yml --profile echo build \
      --build-arg "CARGO_BUILD_JOBS=$jobs" "$service"
  fi
done
