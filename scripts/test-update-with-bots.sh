#!/usr/bin/env bash
# Shell tests for update-with-bots.sh. They use copied fixtures and command mocks.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
sandbox=$(mktemp -d "${TMPDIR:-/var/tmp}/chat-update-with-bots-test.XXXXXX")
trap 'rm -rf "$sandbox"' EXIT
fixture="$sandbox/repo"
fixture_two="$sandbox/repo-two"
common_git="$sandbox/common-git"
flock_bin=$(command -v flock)
mkdir -p "$fixture/scripts" "$fixture/deploy/compose" "$fixture/mock-bin" "$fixture/.git"
cp "$root/update-with-bots.sh" "$fixture/update-with-bots.sh"
chmod +x "$fixture/update-with-bots.sh"
: >"$fixture/deploy/compose/docker-compose.yml"
: >"$fixture/deploy/compose/docker-compose.bots.yml"
cat >"$fixture/scripts/compose-build.sh" <<'EOF'
#!/usr/bin/env bash
printf 'build %s\n' "$@" >>"$MOCK_LOG"
printf 'build-environment %s\n' "${COMPOSE_PROJECT_NAME:-unset}" >>"$MOCK_LOG"
EOF
chmod +x "$fixture/scripts/compose-build.sh"

cat >"$fixture/mock-bin/git" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'git %s\n' "$*" >>"$MOCK_LOG"
case "$1" in
  rev-parse)
    case "${2:-}" in
      --git-path) printf '%s\n' "$PWD/.git/$3" ;;
      --git-common-dir) printf '%s\n' "${MOCK_COMMON_DIR:-$PWD/.git}" ;;
      *)
        if [[ " $* " == *' --git-common-dir '* ]]; then
          printf '%s\n' "${MOCK_COMMON_DIR:-$PWD/.git}"
        else
          exit 9
        fi ;;
    esac ;;
  pull) ;;
  ls-files)
    if [[ -n ${MOCK_TRACKED_FILES:-} ]]; then
      while IFS= read -r file; do printf '%s\0' "$file"; done <<<"$MOCK_TRACKED_FILES"
    fi ;;
  *) exit 9 ;;
esac
EOF
cat >"$fixture/mock-bin/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'docker %s\n' "$*" >>"$MOCK_LOG"
if [[ $1 == image && $2 == inspect ]]; then printf 'sha256:fixture-image\n'; exit 0; fi
if [[ $1 == buildx ]]; then exit 0; fi
if [[ $1 != compose ]]; then exit 8; fi
shift
if [[ " $* " == *" config --format json "* ]]; then
  cat <<'JSON'
{"name":"chat","services":{"server":{"build":{"context":"."}},"web":{"build":{"context":"."}},"echo":{"build":{"context":"."}},"bots":{"build":{"context":"."}}}}
JSON
  exit 0
fi
if [[ " $* " == *" ps -q bots "* ]]; then
  [[ ${MOCK_BOTS_RUNNING:-0} == 1 ]] && printf 'bots-id\n'
  exit 0
fi
if [[ " $* " == *" bots bootstrap "* ]]; then exit "${MOCK_BOOTSTRAP_STATUS:-0}"; fi
if [[ " $* " == *" bots status "* ]]; then
  printf '%s\n' "${MOCK_STATUS_JSON:-{\"registeredAccounts\":0,\"fixtureConversations\":0}"
  exit 0
fi
if [[ " $* " == *" create-invite "* ]]; then
  target=${*: -1}; target=${target#/bot-invites/}
  # The test bind mount has the host path immediately before :/bot-invites.
  for arg in "$@"; do [[ $arg == *:/bot-invites ]] && directory=${arg%:/bot-invites}; done
  printf 'fixture-invite-%s\n' "$target" >"$directory/$target"
  exit 0
fi
exit 0
EOF
cat >"$fixture/mock-bin/sudo" <<'EOF'
#!/usr/bin/env bash
if [[ $1 == env && $2 == -i ]]; then
  shift 2
  values=("MOCK_LOG=$MOCK_LOG")
  while [[ $1 == *=* ]]; do values+=("$1"); shift; done
  exec env -i "${values[@]}" "$@"
fi
exec "$@"
EOF
cat >"$fixture/mock-bin/flock" <<'EOF'
#!/usr/bin/env bash
if [[ ${MOCK_REAL_FLOCK:-0} == 1 ]]; then exec "$MOCK_FLOCK_BIN" "$@"; fi
exit 0
EOF
chmod +x "$fixture/mock-bin/"*

run_at() { local directory=$1; shift; (cd "$directory" && PATH="$fixture/mock-bin:$PATH" MOCK_LOG="$directory/log" MOCK_FLOCK_BIN="$flock_bin" "$@"); }
run() { run_at "$fixture" "$@"; }
run_trace() { run_at "$fixture" bash -x "$fixture/update-with-bots.sh"; }
run_locked_second() { MOCK_COMMON_DIR="$common_git" MOCK_REAL_FLOCK=1 run_at "$fixture_two" "$fixture_two/update-with-bots.sh"; }
assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }
assert_not() { if "$@"; then printf 'unexpected success: %s\n' "$*" >&2; exit 1; fi; }
reset() {
  rm -f "$fixture/log"
  rm -rf "$fixture/bot-config" "$fixture/chat-bot-state" "$fixture/.git"/chat-update* "$common_git"
}

# Validate all flags before Git, Docker, or private-directory changes.
for invalid in '' 0; do
  reset
  assert_not run "$fixture/update-with-bots.sh" --bot-count "$invalid" 2>"$sandbox/invalid.err"
  assert grep -q -- '--bot-count must be an integer' "$sandbox/invalid.err"
  assert test ! -e "$fixture/log"
  assert test ! -e "$fixture/bot-config"
done
for invalid in '' 0; do
  reset
  assert_not run "$fixture/update-with-bots.sh" --messages-per-minute "$invalid" 2>"$sandbox/invalid.err"
  assert grep -q -- '--messages-per-minute must be an integer' "$sandbox/invalid.err"
  assert test ! -e "$fixture/log"
done
reset
huge=$(printf '9%.0s' {1..400})
assert_not run "$fixture/update-with-bots.sh" --bot-count "$huge" 2>"$sandbox/invalid.err"
assert grep -q -- '--bot-count must be an integer' "$sandbox/invalid.err"
assert test ! -e "$fixture/log"

# Dry run can inspect Compose but must not pull, write, build, start, or prune.
reset
run "$fixture/update-with-bots.sh" --dry-run >"$sandbox/dry-run.out"
assert test ! -e "$fixture/bot-config"
assert_not grep -qE 'git pull| up | stop | buildx|build ' "$fixture/log"
assert grep -q 'Dry run:' "$sandbox/dry-run.out"

# Worktrees must share the deployment lock. A held common lock prevents another
# checkout from pulling, resolving Compose, or creating private files.
reset
rm -rf "$fixture_two"
cp -a "$fixture" "$fixture_two"
mkdir -p "$common_git"
ready="$sandbox/common-lock-ready"
# The child shell expands its argument only after it acquires the lock.
# shellcheck disable=SC2016
"$flock_bin" --no-fork -n "$common_git/chat-deploy.lock" sh -c 'printf locked >"$1"; exec sleep 30' sh "$ready" &
lock_holder=$!
for _ in {1..100}; do test -f "$ready" && break; sleep 0.01; done
assert test -f "$ready"
assert_not run_locked_second >"$sandbox/locked.out" 2>"$sandbox/locked.err"
kill "$lock_holder" 2>/dev/null || true
wait "$lock_holder" 2>/dev/null || true
assert test ! -e "$fixture_two/bot-config"
assert grep -Eq 'update.*running' "$sandbox/locked.err"
assert_not grep -qE 'git pull|docker ' "$fixture_two/log"

# Leading-zero flags are accepted but stored in a canonical form.
reset
run "$fixture/update-with-bots.sh" --bot-count 0002 --messages-per-minute 0012 >"$sandbox/canonical.out"
assert grep -q '^CHAT_BOT_COUNT=2$' "$fixture/bot-config/bots.env"
assert grep -q '^CHAT_BOT_MESSAGES_PER_MINUTE=12$' "$fixture/bot-config/bots.env"

# A normal first update creates secure synthetic-only configuration without logging its key.
reset
run "$fixture/update-with-bots.sh" >"$sandbox/normal.out"
assert test "$(stat -c %a "$fixture/bot-config")" = 700
assert test "$(stat -c %a "$fixture/bot-config/bots.env")" = 600
key_before=$(grep '^CHAT_BOT_STATE_KEY=' "$fixture/bot-config/bots.env")
assert grep -q '^CHAT_BOT_MODE=synthetic$' "$fixture/bot-config/bots.env"
assert grep -q '^CHAT_BOT_SERVER=http://127.0.0.1:8080$' "$fixture/bot-config/bots.env"
assert_not grep -Fq "$key_before" "$fixture/log"
assert_not grep -Fq "$key_before" "$sandbox/normal.out"
assert grep -q 'Synthetic bots remain stopped' "$sandbox/normal.out"

# Bash tracing must not reveal the persisted state key.
key_material=${key_before#CHAT_BOT_STATE_KEY=}
: >"$fixture/log"
run_trace >"$sandbox/trace.out" 2>&1
assert_not grep -Fq "$key_material" "$sandbox/trace.out"

# Existing valid configuration retains its secret and preserves values unless flags replace them.
: >"$fixture/log"
run "$fixture/update-with-bots.sh" --bot-count 3 --messages-per-minute 20 >"$sandbox/reconfigure.out"
assert test "$(grep '^CHAT_BOT_STATE_KEY=' "$fixture/bot-config/bots.env")" = "$key_before"
assert grep -q '^CHAT_BOT_COUNT=3$' "$fixture/bot-config/bots.env"
assert grep -q '^CHAT_BOT_MESSAGES_PER_MINUTE=20$' "$fixture/bot-config/bots.env"
: >"$fixture/log"
run "$fixture/update-with-bots.sh" >"$sandbox/reuse.out"
assert_not grep -q '^build ' "$fixture/log"

# Never create replacement identities when encrypted state exists without configuration.
reset
mkdir -m 700 "$fixture/chat-bot-state"; printf x >"$fixture/chat-bot-state/state"
# Check permissions independently of the caller's umask before testing missing keys.
chmod 755 "$fixture/chat-bot-state"
assert_not run "$fixture/update-with-bots.sh" >/dev/null 2>"$sandbox/insecure-state.err"
assert grep -q 'with mode 0700' "$sandbox/insecure-state.err"
assert test ! -e "$fixture/bot-config/bots.env"
chmod 700 "$fixture/chat-bot-state"
assert_not run "$fixture/update-with-bots.sh" >/dev/null 2>"$sandbox/missing-key.err"
assert grep -q 'Refusing nonempty chat-bot-state' "$sandbox/missing-key.err"
assert test ! -e "$fixture/bot-config/bots.env"

# A successful bootstrap creates stable private invites. A resume must reuse the
# key, invite codes, and baseline ledger without another image build.
reset
mkdir -p "$fixture/crates/chat-core"
printf 'first\n' >"$fixture/crates/chat-core/regression.rs"
COMPOSE_PROJECT_NAME=bot-update-test MOCK_TRACKED_FILES='crates/chat-core/regression.rs' run "$fixture/update-with-bots.sh" --enable-bots >"$sandbox/bootstrap-success.out"
key_before=$(grep '^CHAT_BOT_STATE_KEY=' "$fixture/bot-config/bots.env")
cp "$fixture/bot-config/invites.json" "$sandbox/invites-before.json"
assert grep -q 'Synthetic bot runner started' "$sandbox/bootstrap-success.out"
assert grep -q '^build-environment bot-update-test$' "$fixture/log"
assert grep -E -q 'docker .* up -d .*--force-recreate.* bots' "$fixture/log"
: >"$fixture/log"
MOCK_TRACKED_FILES='crates/chat-core/regression.rs' run "$fixture/update-with-bots.sh" --enable-bots >"$sandbox/bootstrap-resume.out"
assert test "$(grep '^CHAT_BOT_STATE_KEY=' "$fixture/bot-config/bots.env")" = "$key_before"
assert cmp -s "$sandbox/invites-before.json" "$fixture/bot-config/invites.json"
assert_not grep -q '^build ' "$fixture/log"
assert_not grep -q 'create-invite' "$fixture/log"
assert grep -E -q 'docker .* up -d .*--force-recreate.* bots' "$fixture/log"

# A chat-core edit changes the web, echo, and bot images, but not the server image.
printf 'second\n' >"$fixture/crates/chat-core/regression.rs"
: >"$fixture/log"
MOCK_TRACKED_FILES='crates/chat-core/regression.rs' run "$fixture/update-with-bots.sh" --enable-bots >"$sandbox/core-edit.out"
assert grep -q '^build web$' "$fixture/log"
assert grep -q '^build echo$' "$fixture/log"
assert grep -q '^build bots$' "$fixture/log"
assert_not grep -q '^build server$' "$fixture/log"

# An ordinary update deliberately stops an existing runner. It must not build,
# bootstrap, or restart bots without the explicit activation flag.
: >"$fixture/log"
MOCK_BOTS_RUNNING=1 MOCK_TRACKED_FILES='crates/chat-core/regression.rs' run "$fixture/update-with-bots.sh" >"$sandbox/stopped.out"
assert grep -q 'docker .* stop bots' "$fixture/log"
assert_not grep -q '^build bots$' "$fixture/log"
assert_not grep -q 'bots bootstrap' "$fixture/log"
assert_not grep -E -q 'docker .* up -d .* bots' "$fixture/log"
assert grep -q 'Synthetic bots remain stopped' "$sandbox/stopped.out"

# A bootstrap error reports only aggregate status, starts a recoverable runner, and keeps secrets private.
reset
MOCK_BOTS_RUNNING=1 MOCK_BOOTSTRAP_STATUS=7 MOCK_STATUS_JSON='{"registeredAccounts":1,"fixtureConversations":3}' \
  assert_not run "$fixture/update-with-bots.sh" --enable-bots >"$sandbox/bootstrap.out" 2>"$sandbox/bootstrap.err"
assert grep -q 'docker .* stop bots' "$fixture/log"
assert grep -q 'docker .* up -d --no-deps --no-build.* server' "$fixture/log"
assert grep -q 'docker .* run --rm --no-deps --no-build --env CHAT_BOT_BOOTSTRAP_LIMIT=2 bots bootstrap' "$fixture/log"
assert grep -q 'docker .* run --rm --no-deps --no-build bots status' "$fixture/log"
stop_line=$(grep -n 'docker .* stop bots' "$fixture/log" | head -1 | cut -d: -f1)
server_line=$(grep -n 'docker .* up -d --no-deps --no-build.* server' "$fixture/log" | head -1 | cut -d: -f1)
bootstrap_line=$(grep -n 'docker .* bots bootstrap' "$fixture/log" | head -1 | cut -d: -f1)
assert test "$stop_line" -lt "$server_line"
assert test "$server_line" -lt "$bootstrap_line"
assert grep -E -q 'docker .* up -d .*--force-recreate.* bots' "$fixture/log"
assert grep -q '1 registered account(s) and 3 fixture conversation(s)' "$sandbox/bootstrap.err"
assert_not grep -Fq "$(grep '^CHAT_BOT_STATE_KEY=' "$fixture/bot-config/bots.env")" "$fixture/log"

printf 'update-with-bots shell tests passed\n'
