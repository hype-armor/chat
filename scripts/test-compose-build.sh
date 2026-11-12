#!/usr/bin/env bash
# Test the build wrapper without a Docker daemon or live services.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
wrapper="$root/scripts/compose-build.sh"
if [[ ! -x "$wrapper" ]]; then
  printf 'Missing or non-executable build wrapper: %s\n' "$wrapper" >&2
  exit 1
fi
sandbox=$(mktemp -d "${TMPDIR:-/var/tmp}/chat-compose-build-test.XXXXXX")
trap 'rm -rf -- "$sandbox"' EXIT
mkdir "$sandbox/bin"

# Inspect logical Dockerfile instructions, not comments or physical lines.
# Every Cargo RUN must own the same BuildKit mutex for its complete lifetime.
check_cargo_dockerfile() {
  local file=$1 service=$2 package=$3
  awk -v service="$service" -v package="$package" '
    function fail(message) {
      print FILENAME ": " message > "/dev/stderr"
      failed = 1
    }
    function inspect(    words, count, i, locked, budget, firstCargo) {
      if (instruction ~ /^FROM[ \t]/) declared = 0
      if (instruction ~ /^ARG[ \t]+CARGO_BUILD_JOBS([= \t]|$)/) declared = 1
      if (instruction !~ /^RUN[ \t]/) return
      if (instruction !~ /(^|[ \t;&])cargo[ \t]/ && instruction !~ /scripts\/build-wasm[.]sh/) return
      cargoRuns++
      if (!declared) fail("Cargo RUN lacks a stage-local CARGO_BUILD_JOBS argument")
      locked = 0
      count = split(instruction, words, /[ \t]+/)
      for (i = 1; i <= count; i++) {
        if (words[i] ~ /^--mount=/ &&
            words[i] ~ /(^--mount=|,)type=cache(,|$)/ &&
            words[i] ~ /(^|,)id=chat-cargo-build-slot(,|$)/ &&
            words[i] ~ /(^|,)sharing=locked(,|$)/) locked = 1
      }
      if (!locked) fail("Cargo RUN lacks the shared chat-cargo-build-slot mutex")
      budget = index(instruction, "export CARGO_BUILD_JOBS=\"${CARGO_BUILD_JOBS:-$(nproc)}\"")
      match(instruction, /cargo[ \t]|scripts\/build-wasm[.]sh/)
      firstCargo = RSTART
      if (!budget || budget >= firstCargo) fail("Cargo RUN must export the override or nproc budget before Cargo starts")
      if (instruction ~ /cargo[ \t]+install[ \t]+wasm-bindgen-cli([ \t]|$)/) wasmInstall++
      if (instruction ~ /scripts\/build-wasm[.]sh/) wasmBuild++
      if (instruction ~ /cargo[ \t]+build[ \t]/ && index(instruction, "-p " package)) serviceBuild++
    }
    /^[ \t]*#/ || /^[ \t]*$/ { next }
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      continued = sub(/\\[ \t]*$/, "", line)
      instruction = instruction " " line
      sub(/^ /, "", instruction)
      if (!continued) {
        inspect()
        instruction = ""
      }
    }
    END {
      if (instruction != "") inspect()
      if (!cargoRuns) fail("No Cargo RUN was checked")
      if (service == "web") {
        if (!wasmInstall) fail("Missing locked wasm-bindgen-cli install")
        if (!wasmBuild) fail("Missing locked WASM build")
      } else if (!serviceBuild) fail("Missing locked service build")
      exit failed ? 1 : 0
    }
  ' "$file"
}

check_cargo_dockerfile "$root/deploy/docker/server.Dockerfile" server chat-server
check_cargo_dockerfile "$root/deploy/docker/web.Dockerfile" web chat-server
check_cargo_dockerfile "$root/deploy/docker/echo.Dockerfile" echo chat-echo
check_cargo_dockerfile "$root/deploy/docker/bots.Dockerfile" bots chat-bot

# The bot image must include only its native worker and offline coordinator
# inputs. Runtime configuration and state remain mounted outside the image.
bots_dockerfile="$root/deploy/docker/bots.Dockerfile"
grep -Fqx 'FROM rust:1.99-bookworm AS build' "$bots_dockerfile"
grep -Fqx 'FROM node:24-bookworm-slim' "$bots_dockerfile"
grep -Fq 'ca-certificates util-linux' "$bots_dockerfile"
grep -Fqx 'COPY --from=build /src/target/release/chat-bot /opt/chat/bin/chat-bot' "$bots_dockerfile"
grep -Fqx 'COPY --from=build /src/scripts/bot-world /opt/chat/scripts/bot-world' "$bots_dockerfile"
grep -Fqx 'COPY --from=build /src/fixtures/bot-world /opt/chat/fixtures/bot-world' "$bots_dockerfile"
if grep -Eq '(^|/)(bots[.]env|invites[.]json)([[:space:]]|$)' "$bots_dockerfile"; then
  echo 'Bot Dockerfile must not copy configuration secrets' >&2
  exit 1
fi

export TEST_BUILD_LOG="$sandbox/build.log" TEST_NPROC_LOG="$sandbox/nproc.log"
export TEST_BUILD_LOCK="$sandbox/build-active"
export PATH="$sandbox/bin:$PATH"

cat > "$sandbox/bin/nproc" <<'FAKE_NPROC'
#!/usr/bin/env bash
set -euo pipefail
printf 'nproc\n' >> "$TEST_NPROC_LOG"
printf '%s\n' "$TEST_CPU_COUNT"
FAKE_NPROC

cat > "$sandbox/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
# Log every invocation, including unexpected commands, before checking it.
printf 'call\n' >> "$TEST_BUILD_LOG"
[[ ${1:-} == compose ]] || { echo 'Expected docker compose' >&2; exit 90; }
shift
echo_profile= bots_profile= build= jobs= base_file= bots_file=
services=()
while (($#)); do
  case "$1" in
    -f)
      (($# >= 2)) || exit 90
      case "$2" in
        deploy/compose/docker-compose.yml) [[ -z $base_file ]] || exit 90; base_file=1 ;;
        deploy/compose/docker-compose.bots.yml) [[ -z $bots_file ]] || exit 90; bots_file=1 ;;
        *) echo "Unexpected Compose file: $2" >&2; exit 90 ;;
      esac
      shift 2 ;;
    --file|--project-directory|--project-name|-p)
      (($# >= 2)) || exit 90
      shift 2 ;;
    --profile)
      case "${2:-}" in
        echo) [[ -z $echo_profile ]] || exit 90; echo_profile=1 ;;
        bots) [[ -z $bots_profile ]] || exit 90; bots_profile=1 ;;
        *) exit 90 ;;
      esac
      shift 2 ;;
    build)
      [[ -z $build ]] || exit 90
      build=build
      shift ;;
    --build-arg)
      [[ ${2:-} =~ ^CARGO_BUILD_JOBS=([1-9][0-9]*)$ ]] || exit 90
      [[ -z $jobs ]] || exit 90
      jobs=${BASH_REMATCH[1]}
      shift 2 ;;
    --*) echo "Unexpected Docker option: $1" >&2; exit 90 ;;
    *) services+=("$1"); shift ;;
  esac
done
[[ -n $base_file && -n $echo_profile && $build == build && -n $jobs && ${#services[@]} == 1 ]] || exit 90
service=${services[0]}
if [[ $service == bots ]]; then
  [[ -n $bots_file && -n $bots_profile ]] || exit 90
else
  [[ -z $bots_file && -z $bots_profile ]] || exit 90
fi
# A parallel wrapper must fail, even if its log would otherwise look ordered.
mkdir "$TEST_BUILD_LOCK" || { echo 'Overlapping Docker builds' >&2; exit 91; }
trap 'rmdir -- "$TEST_BUILD_LOCK"' EXIT
printf 'start|%s|%s\n' "$jobs" "$service" >> "$TEST_BUILD_LOG"
sleep 0.02
if [[ $service == "${TEST_FAIL_SERVICE:-}" ]]; then
  printf 'fail|%s|%s\n' "$jobs" "$service" >> "$TEST_BUILD_LOG"
  exit 17
fi
printf 'end|%s|%s\n' "$jobs" "$service" >> "$TEST_BUILD_LOG"
FAKE_DOCKER
chmod +x "$sandbox/bin/docker" "$sandbox/bin/nproc"

reset_case() {
  : > "$TEST_BUILD_LOG"
  : > "$TEST_NPROC_LOG"
  unset CARGO_BUILD_JOBS TEST_FAIL_SERVICE
  export TEST_CPU_COUNT=1
}

expect_log() {
  local jobs=$1
  shift
  : > "$sandbox/expected.log"
  local service
  for service in "$@"; do
    printf 'call\nstart|%s|%s\nend|%s|%s\n' "$jobs" "$service" "$jobs" "$service" >> "$sandbox/expected.log"
  done
  diff -u "$sandbox/expected.log" "$TEST_BUILD_LOG"
}

run_wrapper() {
  # Running outside the repository also checks path-independent invocation.
  (cd "$sandbox" && bash "$wrapper" "$@") > "$sandbox/output.log" 2>&1
}

for cpus in 1 4; do
  reset_case
  export TEST_CPU_COUNT=$cpus
  run_wrapper || { cat "$sandbox/output.log" >&2; exit 1; }
  expect_log "$cpus" server web echo-invite echo
  [[ $(wc -l < "$TEST_NPROC_LOG") == 1 ]] || { echo 'Expected one CPU detection call' >&2; exit 1; }
done

reset_case
export TEST_CPU_COUNT=8 CARGO_BUILD_JOBS=2
run_wrapper || { cat "$sandbox/output.log" >&2; exit 1; }
expect_log 2 server web echo-invite echo

reset_case
export TEST_CPU_COUNT=3
run_wrapper echo server custom.service_2 || { cat "$sandbox/output.log" >&2; exit 1; }
expect_log 3 echo server custom.service_2

# Only the bots build loads the bots overlay and bots profile.
reset_case
export TEST_CPU_COUNT=3
run_wrapper bots || { cat "$sandbox/output.log" >&2; exit 1; }
expect_log 3 bots

# Validate the complete service list before starting the first build.
for invalid in '--pull' '-x' 'two services' '' 'server;echo'; do
  reset_case
  if run_wrapper server "$invalid"; then
    printf 'Invalid service argument was accepted: <%s>\n' "$invalid" >&2
    exit 1
  fi
  [[ ! -s "$TEST_BUILD_LOG" ]] || { echo 'Docker ran for an invalid service argument' >&2; exit 1; }
done

# Invalid overrides must fail before any Docker call, not only before a build.
for invalid in 0 -1 1.5 abc '1 2' ' 2' '2 ' '--help'; do
  reset_case
  export CARGO_BUILD_JOBS=$invalid
  if run_wrapper; then
    printf 'Invalid job count was accepted: <%s>\n' "$invalid" >&2
    exit 1
  fi
  [[ ! -s "$TEST_BUILD_LOG" ]] || { echo 'Docker ran for an invalid override' >&2; exit 1; }
done

# A detector result also must not reach Docker unless it is a positive integer.
for invalid in 0 -1 broken; do
  reset_case
  export TEST_CPU_COUNT=$invalid
  if run_wrapper; then
    printf 'Invalid detected job count was accepted: <%s>\n' "$invalid" >&2
    exit 1
  fi
  [[ ! -s "$TEST_BUILD_LOG" ]] || { echo 'Docker ran for an invalid CPU count' >&2; exit 1; }
done

reset_case
export TEST_FAIL_SERVICE=web
if run_wrapper; then
  echo 'A failed Docker build did not fail the wrapper' >&2
  exit 1
fi
printf 'call\nstart|1|server\nend|1|server\ncall\nstart|1|web\nfail|1|web\n' > "$sandbox/expected.log"
diff -u "$sandbox/expected.log" "$TEST_BUILD_LOG"

printf 'compose-build shell tests passed\n'
