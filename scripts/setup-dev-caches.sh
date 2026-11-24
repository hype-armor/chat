#!/usr/bin/env bash
# Install user-owned command shims. No builds, service changes, or cache removal.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
bin="$HOME/.local/share/chat-dev/bin"
mkdir -p "$bin"
for name in cargo pnpm; do
  dest="$bin/$name"
  if [[ -e $dest ]] && ! grep -q '^# chat-dev managed shim$' "$dest"; then
    echo "Refusing to replace unmanaged file: $dest" >&2; exit 1
  fi
  {
    printf '#!/usr/bin/env bash\n# chat-dev managed shim\nset -euo pipefail\n'
    printf 'shim_dir=%q\nlauncher=%q\nexpected_common=%q\n' "$bin" "$root/scripts/chat-dev" "$common"
    cat <<'SHIM'
name=${0##*/}
# Resolve the actual command without recursively invoking this shim.
IFS=: read -ra entries <<< "$PATH"
clean=()
for entry in "${entries[@]}"; do [[ $entry == "$shim_dir" ]] || clean+=("$entry"); done
PATH=$(IFS=:; echo "${clean[*]}")
export PATH
real=$(command -v "$name") || { echo "Install $name before using this shim." >&2; exit 127; }
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [[ $common == "$expected_common" && ${CHAT_DEV_CACHE_MODE:-shared} != isolated ]]; then
  export CHAT_DEV_WORKTREE=$(git rev-parse --show-toplevel)
  # Legacy WASM scripts assume ./target. Require the compatible script first.
  if [[ $name == cargo && " $* " == *wasm32-unknown-unknown* && -f "$CHAT_DEV_WORKTREE/scripts/build-wasm.sh" ]] && ! grep -q 'cargo metadata' "$CHAT_DEV_WORKTREE/scripts/build-wasm.sh"; then
    echo 'Legacy WASM worktree: keeping its WASM target local until build-wasm.sh uses cargo metadata.' >&2
    exec "$real" "$@"
  fi
  exec bash "$launcher" "$real" "$@"
fi
exec "$real" "$@"
SHIM
  } > "$dest"
  chmod +x "$dest"
done
printf "Installed shims. Activate in each shell with:\nexport PATH=\"%s:\$PATH\"\n" "$bin"
printf 'Run this setup in another clone to register that clone instead. Existing caches were not removed.\n'
