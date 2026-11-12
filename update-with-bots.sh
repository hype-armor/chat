#!/usr/bin/env bash
# Update the local stack and optionally bootstrap the synthetic bot runner.
# The normal path configures private bot files but never starts bot networking.
# Disable inherited tracing before reading or generating credentials.
set +x
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./update-with-bots.sh [--force] [--dry-run] [--enable-bots]
                             [--bot-count 1..100]
                             [--messages-per-minute 1..120] [--refresh-invites]

--enable-bots explicitly creates or renews invites, resumes bootstrap, and starts
synthetic bots. Without it, a running bot service is stopped and remains stopped.
EOF
}

fail() { printf '%s\n' "$*" >&2; return 1; }

validate_integer() {
  local value=$1 lower=$2 upper=$3 label=$4
  if [[ $value =~ ^0*([1-9][0-9]{0,2})$ ]]; then
    if ((10#$value >= lower && 10#$value <= upper)); then return 0; fi
  fi
  printf '%s must be an integer from %s through %s.\n' "$label" "$lower" "$upper" >&2
  return 2
}

# Read a deliberately small env-file format without evaluating it. The result is
# JSON so neither values nor shell syntax from the private file execute here.
read_bot_config() {
  python3 - "$1" <<'PY'
import base64
import json
import os
import stat
import sys

path = sys.argv[1]
parent = os.path.dirname(path)
parent_st = os.stat(parent)
if not stat.S_ISDIR(parent_st.st_mode) or stat.S_IMODE(parent_st.st_mode) != 0o700:
    raise SystemExit('bot-config must be a directory with mode 0700.')
if parent_st.st_uid != os.geteuid():
    raise SystemExit('bot-config must be owned by the calling user.')
st = os.stat(path)
if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600:
    raise SystemExit('bots.env must be a regular file with mode 0600.')
if st.st_uid != os.geteuid():
    raise SystemExit('bots.env must be owned by the calling user.')
values = {}
expected = {
    'CHAT_BOTS_ENABLED', 'CHAT_BOT_MODE', 'CHAT_BOT_SERVER', 'CHAT_BOT_STATE_DIR',
    'CHAT_BOT_STATE_KEY', 'CHAT_BOT_USERNAME_PREFIX', 'CHAT_BOT_COUNT',
    'CHAT_BOT_MESSAGES_PER_MINUTE', 'CHAT_BOT_INVITES_FILE',
}
with open(path, encoding='utf-8') as source:
    for raw in source:
        line = raw.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise SystemExit('bots.env contains an invalid line.')
        key, value = line.split('=', 1)
        if key not in expected or key in values or not key or any(c.isspace() for c in key):
            raise SystemExit('bots.env contains an unsupported setting.')
        values[key] = value
if set(values) != expected:
    raise SystemExit('bots.env is incomplete.')
if values['CHAT_BOTS_ENABLED'] != 'true':
    raise SystemExit('bots.env must enable the local runner.')
if values['CHAT_BOT_MODE'] != 'synthetic':
    raise SystemExit('bots.env must use synthetic mode.')
if values['CHAT_BOT_SERVER'] != 'http://127.0.0.1:8080':
    raise SystemExit('bots.env has an unexpected bot server.')
if values['CHAT_BOT_STATE_DIR'] != '/var/lib/chat-bots':
    raise SystemExit('bots.env has an unexpected state directory.')
if values['CHAT_BOT_USERNAME_PREFIX'] != 'ai_bot':
    raise SystemExit('bots.env has an unexpected username prefix.')
if values['CHAT_BOT_INVITES_FILE'] != '/run/chat-bots/invites.json':
    raise SystemExit('bots.env has an unexpected invite file.')
try:
    key = base64.b64decode(values['CHAT_BOT_STATE_KEY'], validate=True)
except Exception:
    raise SystemExit('CHAT_BOT_STATE_KEY must be canonical base64 for 32 random bytes.')
if len(key) != 32 or base64.b64encode(key).decode() != values['CHAT_BOT_STATE_KEY']:
    raise SystemExit('CHAT_BOT_STATE_KEY must be canonical base64 for 32 random bytes.')
for name, maximum in [('CHAT_BOT_COUNT', 100), ('CHAT_BOT_MESSAGES_PER_MINUTE', 120)]:
    value = values[name]
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= maximum:
        raise SystemExit(f'{name} must be an integer in its allowed range.')
    values[name] = str(int(value))
print(json.dumps(values))
PY
}

write_bot_config() {
  local config_dir=$1 count=$2 rate=$3 key=$4 temporary
  temporary=$(mktemp "$config_dir/.bots.env.XXXXXX")
  chmod 600 "$temporary"
  {
    printf '%s\n' 'CHAT_BOTS_ENABLED=true'
    printf '%s\n' 'CHAT_BOT_MODE=synthetic'
    printf '%s\n' 'CHAT_BOT_SERVER=http://127.0.0.1:8080'
    printf '%s\n' 'CHAT_BOT_STATE_DIR=/var/lib/chat-bots'
    printf 'CHAT_BOT_STATE_KEY=%s\n' "$key"
    printf '%s\n' 'CHAT_BOT_USERNAME_PREFIX=ai_bot'
    printf 'CHAT_BOT_COUNT=%s\n' "$count"
    printf 'CHAT_BOT_MESSAGES_PER_MINUTE=%s\n' "$rate"
    printf '%s\n' 'CHAT_BOT_INVITES_FILE=/run/chat-bots/invites.json'
  } >"$temporary"
  mv -f -- "$temporary" "$config_dir/bots.env"
}

configure_bots() {
  local config_dir=$1 data_dir=$2 count_override=$3 rate_override=$4 dry_run=$5
  local config="$config_dir/bots.env" existing='' count=2 rate=12 key='' mode owner
  if [[ -e $data_dir ]]; then
    mode=$(stat -c %a -- "$data_dir")
    owner=$(stat -c %u -- "$data_dir")
    [[ -d $data_dir && $mode == 700 && $owner == $(id -u) ]] || {
      fail "chat-bot-state must be owned by the calling user with mode 0700."
      return
    }
  fi
  if [[ -e $config ]]; then
    existing=$(read_bot_config "$config") || return
    count=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["CHAT_BOT_COUNT"])' <<<"$existing")
    rate=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["CHAT_BOT_MESSAGES_PER_MINUTE"])' <<<"$existing")
    key=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["CHAT_BOT_STATE_KEY"])' <<<"$existing")
  elif [[ -d $data_dir ]] && [[ -n $(find "$data_dir" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    fail "Refusing nonempty chat-bot-state without bots.env and its state key."
    return
  fi
  [[ -z $count_override ]] || count=$count_override
  [[ -z $rate_override ]] || rate=$rate_override
  if [[ $dry_run == true ]]; then
    if [[ -n $existing ]]; then
      printf 'Bot configuration is valid; count %s and rate %s would be retained or updated.\n' "$count" "$rate"
    else
      printf 'Bot configuration would be created with count %s and rate %s.\n' "$count" "$rate"
    fi
    return
  fi
  umask 077
  mkdir -p -- "$config_dir" "$data_dir"
  chmod 700 -- "$config_dir" "$data_dir"
  if [[ -z $key ]]; then
    key=$(python3 -c 'import base64, secrets; print(base64.b64encode(secrets.token_bytes(32)).decode())')
  fi
  write_bot_config "$config_dir" "$count" "$rate" "$key"
}

fingerprints() {
  local include_bots=$1 dry_run=$2
  python3 - "$script" "$include_bots" "$dry_run" <<'PY'
import hashlib
import json
import os
import stat
import subprocess
import sys

compose = ['docker', 'compose', '-f', 'deploy/compose/docker-compose.yml', '-f',
           'deploy/compose/docker-compose.bots.yml', '--profile', 'echo', '--profile', 'bots']
config_args = ['config', '--format', 'json']
if sys.argv[3] == 'true':
    config_args.append('--no-env-resolution')
config = json.loads(subprocess.check_output(compose + config_args))
services = ['server', 'web', 'echo'] + (['bots'] if sys.argv[2] == 'true' else [])
hashes = {name: hashlib.sha256(b'chat-update-with-bots-inputs-v1\0') for name in services}

def affected(path):
    if path in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml', '.dockerignore', '.gitignore') or path.startswith('.cargo/'):
        return services
    if path.startswith('crates/') and path.endswith('/Cargo.toml'):
        return services
    if path.startswith(('crates/chat-proto/', 'proto/')):
        return services
    if path.startswith('crates/chat-server/'):
        return ['server']
    if path.startswith(('crates/chat-core/', 'crates/chat-echo/')):
        return ['web', 'echo'] + (['bots'] if 'bots' in services else []) if path.startswith('crates/chat-core/') else ['echo']
    if path.startswith(('crates/chat-bot/', 'scripts/bot-world/', 'fixtures/bot-world/')):
        return ['bots'] if 'bots' in services else []
    if path.startswith(('web/', 'patches/')) or path in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'scripts/build-wasm.sh', 'scripts/wasm-bindgen-version.sh'):
        return ['web']
    if path == 'deploy/docker/server.Dockerfile': return ['server']
    if path == 'deploy/docker/echo.Dockerfile': return ['echo']
    if path in ('deploy/docker/web.Dockerfile', 'deploy/docker/nginx.conf.template', 'deploy/docker/security-headers.inc.template'): return ['web']
    if path == 'scripts/compose-build.sh': return services
    if path in ('deploy/compose/docker-compose.bots.yml', 'deploy/docker/bots.Dockerfile'):
        return ['bots'] if 'bots' in services else []
    if path.startswith(('docs/', '.github/', 'deploy/helm/', 'deploy/k3s/', 'deploy/compose/')) or path in ('README.md', 'CLAUDE.md', 'AGENTS.md', 'LICENSE', 'LICENSE.md') or path.startswith('scripts/test-'):
        return []
    return services

def add_file(digest, path):
    digest.update(os.fsencode(path) + b'\0')
    try: info = os.lstat(path)
    except FileNotFoundError:
        digest.update(b'missing\0'); return
    digest.update(str(stat.S_IMODE(info.st_mode)).encode() + b'\0')
    if stat.S_ISLNK(info.st_mode): digest.update(b'link\0' + os.fsencode(os.readlink(path)) + b'\0')
    elif stat.S_ISREG(info.st_mode):
        with open(path, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''): digest.update(chunk)
        digest.update(b'\0')
    else: raise RuntimeError('Unsupported build input: ' + path)

paths = set(subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split(b'\0'))
for raw in sorted(paths - {b''}):
    path = os.fsdecode(raw)
    for service in affected(path): add_file(hashes[service], path)
for service in services:
    definition = config['services'][service]
    hashes[service].update(json.dumps(definition['build'], sort_keys=True).encode())
    add_file(hashes[service], sys.argv[1])
    image = definition.get('image') or config['name'] + '-' + service
    binds = hashlib.sha256(b'chat-update-with-bots-bind-files-v1\0')
    for volume in definition.get('volumes', []):
        if volume.get('type') != 'bind': continue
        source = volume['source']; binds.update(json.dumps(volume, sort_keys=True).encode())
        if os.path.isfile(source):
            info = os.stat(source); binds.update(str((stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)).encode())
            with open(source, 'rb') as mounted:
                for chunk in iter(lambda: mounted.read(1024 * 1024), b''): binds.update(chunk)
        else: binds.update(b'not-a-regular-file\0')
    print(service, hashes[service].hexdigest(), image, binds.hexdigest(), sep='\t')
PY
}

create_invites() {
  local count=$1 config_dir=$2 uid=$3 gid=$4 log=$5 number name
  local invite_dir="$config_dir/invite-files"
  umask 077
  mkdir -p -- "$invite_dir"
  chmod 700 -- "$invite_dir"
  for ((number = 1; number <= count; number++)); do
    printf -v name 'bot-%03d' "$number"
    if [[ $refresh_invites == true || ! -f $invite_dir/$name ]]; then
      "${compose[@]}" run --rm --no-deps --no-build --user "$uid:$gid" --volume "$invite_dir:/bot-invites" \
        server create-invite --code-file "/bot-invites/$name" >>"$log" 2>&1
      chmod 600 -- "$invite_dir/$name"
    fi
  done
  python3 - "$invite_dir" "$count" "$config_dir/invites.json" <<'PY'
import json
import os
import sys
import tempfile

directory, count, output = sys.argv[1], int(sys.argv[2]), sys.argv[3]
values = {}
for number in range(1, count + 1):
    name = f'bot-{number:03d}'
    with open(os.path.join(directory, name), encoding='utf-8') as source:
        value = source.read().strip()
    if not value:
        raise SystemExit('An invite command did not create its private code file.')
    values[name] = value
fd, temporary = tempfile.mkstemp(prefix='.invites.', dir=os.path.dirname(output))
os.chmod(temporary, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as target:
    json.dump(values, target, separators=(',', ':'))
    target.write('\n')
    target.flush()
    os.fsync(target.fileno())
os.replace(temporary, output)
PY
}

registered_accounts() {
  local status_file=$1
  python3 - "$status_file" <<'PY'
import json
import sys
try:
    value = json.load(open(sys.argv[1], encoding='utf-8'))
    registered = value['registeredAccounts']
    fixtures = value['fixtureConversations']
    if type(registered) is not int or registered < 0 or type(fixtures) is not int or fixtures < 0:
        raise ValueError
    print(f'{registered} {fixtures}')
except Exception:
    print('0 0')
PY
}

main() {
  local force=false dry_run=false enable_bots=false refresh_invites=false
  local count_override='' rate_override='' argument
  while (($#)); do
    case "$1" in
      --force) force=true ;;
      --dry-run) dry_run=true ;;
      --enable-bots) enable_bots=true ;;
      --refresh-invites) refresh_invites=true ;;
      --bot-count|--messages-per-minute)
        (($# >= 2)) || { printf '%s requires a value.\n' "$1" >&2; return 2; }
        argument=$2
        if [[ $1 == --bot-count ]]; then
          validate_integer "$argument" 1 100 '--bot-count' || return
          count_override=$((10#$argument))
        else
          validate_integer "$argument" 1 120 '--messages-per-minute' || return
          rate_override=$((10#$argument))
        fi
        shift ;;
      --help|-h) usage; return ;;
      *) printf 'Unknown argument: %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  [[ -z $count_override ]] || validate_integer "$count_override" 1 100 '--bot-count' || return
  [[ -z $rate_override ]] || validate_integer "$rate_override" 1 120 '--messages-per-minute' || return
  if [[ $refresh_invites == true && $enable_bots == false ]]; then
    printf '%s\n' '--refresh-invites requires --enable-bots.' >&2
    return 2
  fi

  script=$(realpath -- "${BASH_SOURCE[0]}")
  cd -- "$(dirname -- "$script")"
  local config_dir data_dir uid gid state shared_lock repository_lock plan current previous previous_image previous_bind digest image bind_digest temporary
  config_dir=$(realpath -m -- bot-config)
  data_dir=$(realpath -m -- chat-bot-state)
  uid=$(id -u); gid=$(id -g)
  # Compose needs these paths and IDs. Bot secrets stay only in bots.env.
  export CHAT_BOT_CONFIG_DIR="$config_dir" CHAT_BOT_DATA_DIR="$data_dir" CHAT_BOT_UID="$uid" CHAT_BOT_GID="$gid"
  state=$(git rev-parse --git-path chat-update-with-bots)
  shared_lock=$(git rev-parse --git-path chat-update/lock)
  repository_lock="$(git rev-parse --git-common-dir)/chat-deploy.lock"
  compose=(docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.bots.yml --profile echo --profile bots)

  if [[ $dry_run == true ]]; then
    printf 'Dry run: current checkout only; no pull, files, build, deployment, or prune.\n'
    configure_bots "$config_dir" "$data_dir" "$count_override" "$rate_override" true
  else
    mkdir -p -- "$state" "$(dirname -- "$shared_lock")" "$(dirname -- "$repository_lock")"
    # Serialize new updaters across worktrees, and the old updater in this checkout.
    exec 8>"$repository_lock"
    flock -n 8 || { printf 'Another repository update is running.\n' >&2; return 1; }
    exec 9>"$shared_lock"
    flock -n 9 || { printf 'Another update is running.\n' >&2; return 1; }
    git pull --ff-only
    # A coordinator may hold state locks. Stop it before replacing server or state.
    if [[ -n $("${compose[@]}" ps -q bots 2>/dev/null) ]]; then
      "${compose[@]}" stop bots
      printf 'Stopped the bot service before the update.\n'
    fi
    configure_bots "$config_dir" "$data_dir" "$count_override" "$rate_override" false
  fi

  local -a builds=() recreate=() base_services=(server web echo)
  plan=$(fingerprints "$enable_bots" "$dry_run")
  while IFS=$'\t' read -r service digest image bind_digest; do
    previous='' previous_image='' previous_bind=''
    if [[ -f $state/$service ]]; then read -r previous previous_image previous_bind <"$state/$service" || true; fi
    current=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || current=
    if [[ $force == true || $digest != "$previous" || -z $current || $current != "$previous_image" ]]; then
      builds+=("$service"); printf '%s: build required\n' "$service"
    else
      printf '%s: reuse unchanged image\n' "$service"
    fi
    if [[ $force == true || -z $previous_bind || $bind_digest != "$previous_bind" ]]; then
      recreate+=("$service"); printf '%s: recreate for configuration baseline or forced update\n' "$service"
    fi
  done <<<"$plan"
  [[ $dry_run == true ]] && return

  if ((${#builds[@]})); then
    local -a build_environment=("PATH=$PATH" "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-1}" "CHAT_BOT_CONFIG_DIR=$CHAT_BOT_CONFIG_DIR" "CHAT_BOT_DATA_DIR=$CHAT_BOT_DATA_DIR" "CHAT_BOT_UID=$CHAT_BOT_UID" "CHAT_BOT_GID=$CHAT_BOT_GID")
    if [[ -n ${COMPOSE_PROJECT_NAME:-} ]]; then build_environment+=("COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"); fi
    sudo env -i "${build_environment[@]}" ./scripts/compose-build.sh "${builds[@]}"
  else
    printf 'No image builds needed.\n'
  fi
  if [[ $(fingerprints "$enable_bots" false) != "$plan" ]]; then
    printf 'Build inputs changed during the update. Run update-with-bots.sh again.\n' >&2
    return 1
  fi
  local item extra
  for service in "${base_services[@]}"; do
    extra=()
    for item in "${recreate[@]}"; do [[ $item == "$service" ]] && extra=(--force-recreate); done
    "${compose[@]}" up -d --no-deps --no-build "${extra[@]}" "$service"
  done

  if [[ $enable_bots == true ]]; then
    local bot_config count log bootstrap_status status_file progress accounts fixtures
    bot_config=$(read_bot_config "$config_dir/bots.env")
    count=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["CHAT_BOT_COUNT"])' <<<"$bot_config")
    log="$config_dir/update-with-bots.log"
    : >"$log"; chmod 600 "$log"
    create_invites "$count" "$config_dir" "$uid" "$gid" "$log"
    set +e
    "${compose[@]}" run --rm --no-deps --no-build --env "CHAT_BOT_BOOTSTRAP_LIMIT=$count" bots bootstrap >>"$log" 2>&1
    bootstrap_status=$?
    set -e
    if ((bootstrap_status != 0)); then
      status_file=$(mktemp "$config_dir/.bot-status.XXXXXX"); chmod 600 "$status_file"
      "${compose[@]}" run --rm --no-deps --no-build bots status >"$status_file" 2>>"$log" || true
      progress=$(registered_accounts "$status_file"); rm -f -- "$status_file"
      read -r accounts fixtures <<<"$progress"
      printf 'Bot bootstrap stopped after %s registered account(s) and %s fixture conversation(s).\n' "$accounts" "$fixtures" >&2
      if ((accounts > 0)); then "${compose[@]}" up -d --no-deps --no-build --force-recreate bots; fi
      printf 'Private bot details are in bot-config/update-with-bots.log. State and keys were retained.\n' >&2
      return "$bootstrap_status"
    fi
    # Rebind the server namespace and atomic invite-file replacement on every run.
    "${compose[@]}" up -d --no-deps --no-build --force-recreate bots
    printf 'Synthetic bot runner started.\n'
  else
    printf 'Synthetic bots remain stopped. Use --enable-bots to bootstrap and start them.\n'
  fi

  while IFS=$'\t' read -r service digest image bind_digest; do
    current=$(docker image inspect --format '{{.Id}}' "$image")
    temporary=$(mktemp "$state/.next.XXXXXX")
    printf '%s %s %s\n' "$digest" "$current" "$bind_digest" >"$temporary"
    mv -f -- "$temporary" "$state/$service"
  done <<<"$plan"
  if ! sudo docker buildx prune --force --filter "until=${CHAT_BUILD_CACHE_MAX_AGE:-24h}"; then
    printf 'Deployment succeeded, but build-cache cleanup failed.\n' >&2
    return 1
  fi
}

main "$@"
