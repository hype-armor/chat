#!/usr/bin/env bash
# Pull and rebuild changed server and web inputs before restarting.
# This updater builds and starts the app stack, not development test bots.
# First run establishes a baseline. --force rebuilds the app images.
# --dry-run inspects the current checkout without pulling or deploying.
# --build-only pulls and builds but does not stop or start services.
# A supervisor may inherit the existing update lock via CHAT_UPDATE_LOCK_FD.
# After deployment, prune unused builder cache older than 24h (builder-wide).
# Override retention with CHAT_BUILD_CACHE_MAX_AGE, e.g. 72h.
set -euo pipefail

fingerprints() {
  python3 - "$script" <<'PY'
import hashlib
import json
import os
import stat
import subprocess
import sys

compose = ['docker', 'compose', '--env-file', '.env', '-f', 'deploy/compose/docker-compose.yml']
config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
services = ['server', 'web']
hashes = {name: hashlib.sha256(b'chat-update-inputs-v1\0') for name in services}

# Treat unknown inputs conservatively. Keep this map aligned with the Dockerfiles.
def affected(path):
    if path in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml', '.dockerignore', '.gitignore') or path.startswith('.cargo/'):
        return services
    if path.startswith('crates/') and path.endswith('/Cargo.toml'):
        return services  # Cargo resolves workspace manifests even for unbuilt members.
    if path.startswith(('crates/chat-proto/', 'proto/')):
        return services
    if path.startswith('crates/chat-server/'):
        return ['server']
    if path.startswith('crates/chat-core/'):
        return ['web']
    if path.startswith('crates/chat-echo/'):
        return []
    if path.startswith(('web/', 'patches/')) or path in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'scripts/build-wasm.sh', 'scripts/wasm-bindgen-version.sh'):
        return ['web']
    if path == 'deploy/docker/server.Dockerfile':
        return ['server']
    if path == 'deploy/docker/echo.Dockerfile':
        return []
    if path in ('deploy/docker/web.Dockerfile', 'deploy/docker/nginx.conf.template', 'deploy/docker/security-headers.inc.template'):
        return ['web']
    if path.startswith(('docs/', '.github/', 'deploy/helm/', 'deploy/k3s/', 'deploy/compose/')) or path in ('README.md', 'CLAUDE.md', 'AGENTS.md', 'LICENSE', 'LICENSE.md') or path.startswith('scripts/test-'):
        return []  # Compose applies runtime configuration below; these are not compiled.
    return services

def add_file(digest, path):
    raw = os.fsencode(path)
    digest.update(raw + b'\0')
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        digest.update(b'missing\0')
        return
    digest.update(str(stat.S_IMODE(info.st_mode)).encode() + b'\0')
    if stat.S_ISLNK(info.st_mode):
        digest.update(b'link\0' + os.fsencode(os.readlink(path)) + b'\0')
    elif stat.S_ISREG(info.st_mode):
        with open(path, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        digest.update(b'\0')
    else:
        raise RuntimeError('Unsupported build input: ' + path)

# Include tracked local edits, deletions, and non-ignored untracked source files.
# Generated outputs excluded by Git/Docker ignore rules must not trigger rebuilds.
paths = set(subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split(b'\0'))
for raw in sorted(paths - {b''}):
    path = os.fsdecode(raw)
    for service in affected(path):
        add_file(hashes[service], path)

for service in services:
    definition = config['services'][service]
    hashes[service].update(json.dumps(definition['build'], sort_keys=True).encode())
    add_file(hashes[service], sys.argv[1])  # Updating the selector invalidates old baselines.
    image = definition.get('image') or config['name'] + '-' + service
    # File bind mounts (e.g. nginx's API proxy config) need recreation after
    # replacement. Directory/data-volume changes do not rebuild an image.
    binds = hashlib.sha256(b'chat-update-bind-files-v1\0')
    for volume in definition.get('volumes', []):
        if volume.get('type') != 'bind':
            continue
        source = volume['source']
        binds.update(json.dumps(volume, sort_keys=True).encode())
        if os.path.isfile(source):
            # Bind mounts follow symlinks; hash the actual mounted file.
            info = os.stat(source)
            binds.update(str((stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)).encode())
            with open(source, 'rb') as mounted:
                for chunk in iter(lambda: mounted.read(1024 * 1024), b''):
                    binds.update(chunk)
        else:
            binds.update(b'not-a-regular-file\0')
    print(service, hashes[service].hexdigest(), image, binds.hexdigest(), sep='\t')
PY
}

main() {
  local force=false dry_run=false build_only=false
  while (($#)); do
    case "$1" in
      --force) force=true ;;
      --dry-run) dry_run=true ;;
      --build-only) build_only=true ;;
      --help|-h) printf 'Usage: %s [--force] [--dry-run] [--build-only]\n' "$0"; return ;;
      *) printf 'Unknown argument: %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  local script
  script=$(realpath -- "${BASH_SOURCE[0]}")
  cd -- "$(dirname -- "$script")"
  local state
  state=$(git rev-parse --git-path chat-update)
  # Do not let the shell or .env enable development profiles. HTTPS, if it
  # was running, is selected explicitly below.
  export COMPOSE_PROFILES=
  local -a compose=(docker compose --env-file .env -f deploy/compose/docker-compose.yml)
  if [[ $dry_run == false ]]; then
    mkdir -p -- "$state"
    if [[ -n ${CHAT_UPDATE_LOCK_FD:-} ]]; then
      # A maintenance supervisor can hold this exact lock across builds and
      # deployment. A different or closed descriptor is never accepted.
      local inherited=$CHAT_UPDATE_LOCK_FD inherited_id lock_id
      [[ $inherited =~ ^[0-9]+$ && $inherited -ge 3 && $inherited -le 255 ]] || {
        printf 'Invalid inherited update lock descriptor.\n' >&2; return 1;
      }
      inherited_id=$(stat -Lc '%d:%i' "/proc/self/fd/$inherited") || return 1
      lock_id=$(stat -Lc '%d:%i' "$state/lock") || return 1
      [[ $inherited_id == "$lock_id" ]] || {
        printf 'Inherited descriptor is not the update lock.\n' >&2; return 1;
      }
      flock -n "$inherited" || { printf 'Another update is running.\n' >&2; return 1; }
    else
      exec 9>"$state/lock"
      flock -n 9 || { printf 'Another update is running.\n' >&2; return 1; }
    fi
    # The supervisor creates $state/maintenance-in-progress under this same
    # lock before a migration and removes it only after recovery is complete.
    # The Git directory and state directory must be private to trusted operators;
    # this presence gate is not protection against a writer that can remove it.
    # Any object at this name blocks updates, including malformed files and links.
    if ! python3 - "$state/maintenance-in-progress" <<'PY'
import os
import sys

try:
    os.lstat(sys.argv[1])
except FileNotFoundError:
    sys.exit(0)
except OSError as error:
    print(f'Cannot check maintenance marker: {error}', file=sys.stderr)
    sys.exit(1)
print('Maintenance marker exists; supervised recovery is required.', file=sys.stderr)
sys.exit(1)
PY
    then
      return 1
    fi
    git pull --ff-only
  else
    printf 'Dry run: current checkout only; no pull, build, or deployment.\n'
  fi

  local plan service digest image bind_digest previous previous_image previous_bind current
  local -a builds=() recreate=()
  plan=$(fingerprints)
  while IFS=$'\t' read -r service digest image bind_digest; do
    previous= previous_image= previous_bind=
    if [[ -f "$state/$service" ]]; then
      if ! read -r previous previous_image previous_bind < "$state/$service"; then
        previous= previous_image= previous_bind=
      fi
    fi
    current=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || current=
    if [[ $force == true || $digest != "$previous" || -z $current || $current != "$previous_image" ]]; then
      builds+=("$service")
      printf '%s: build required\n' "$service"
    else
      printf '%s: reuse unchanged image\n' "$service"
    fi
    if [[ $force == true || -z $previous_bind || $bind_digest != "$previous_bind" ]]; then
      recreate+=("$service")
      printf '%s: recreate for configuration baseline or forced update\n' "$service"
    fi
  done <<< "$plan"
  if [[ $dry_run == true ]]; then return; fi

  # Never call the wrapper with an empty list: its default builds all images.
  if ((${#builds[@]})); then
    sudo env CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$(nproc)}" ./scripts/compose-build.sh "${builds[@]}"
  else
    printf 'No image builds needed.\n'
  fi
  # Detect source/config edits during a long build before changing containers.
  if [[ $(fingerprints) != "$plan" ]]; then
    printf 'Build inputs changed during the update. Run update.sh again.\n' >&2
    return 1
  fi
  if [[ $build_only == true ]]; then
    printf 'Build complete; services were not changed.\n'
    return
  fi
  # Remember whether the optional HTTPS profile is running. Compose down
  # removes the project's containers, including dependencies and profiles.
  local running
  running=$("${compose[@]}" --profile https ps --status running --services)
  local -a startup=("${compose[@]}")
  if grep -Fxq https <<< "$running"; then
    startup+=(--profile https)
  fi
  # Keep the existing stack online during the builds above. Do not pass -v:
  # PostgreSQL, blobs, and other named volumes must survive the restart.
  # Include legacy echo containers only in shutdown, never in startup.
  "${compose[@]}" --profile echo --profile https down
  "${startup[@]}" up -d --no-build

  # Advance state only after every build and deployment command succeeds.
  local temporary
  while IFS=$'\t' read -r service digest image bind_digest; do
    current=$(docker image inspect --format '{{.Id}}' "$image")
    temporary=$(mktemp "$state/.next.XXXXXX")
    printf '%s %s %s\n' "$digest" "$current" "$bind_digest" > "$temporary"
    mv -f -- "$temporary" "$state/$service"
  done <<< "$plan"

  # Use the same sudo/default Buildx builder as compose-build.sh. Keep recent
  # reusable layers; never prune images, containers, volumes, or app data.
  if ! sudo docker buildx prune --force --filter "until=${CHAT_BUILD_CACHE_MAX_AGE:-24h}"; then
    printf 'Deployment succeeded, but build-cache cleanup failed.\n' >&2
    return 1
  fi
}

main "$@"; exit
