# Shared development caches

Run `bash scripts/setup-dev-caches.sh` after cloning. Add the printed PATH export
at the end of your shell startup file, then open a new shell. This installs
user-owned cargo and pnpm shims for this clone and its Git worktrees only.
Re-run setup after moving the clone. One registered clone per user is supported.
No system executables or services change. Other repositories pass through unchanged.

The default cache is `${XDG_CACHE_HOME:-$HOME/.cache}/chat-dev`:

- `target`: Cargo compiled artifacts. Cargo locks concurrent access. Different
  compilers/features may still compile separate artifacts. Never cargo-clean this
  shared directory while another developer session uses it.
- `pnpm-store`: pnpm packages. Keep each worktree's node_modules separate. pnpm can
  hard-link packages on the same filesystem; cross-filesystem installs may copy.
- `playwright`: browser downloads. Use `scripts/chat-dev pnpm ...` for commands
  started outside the shims, or invoke the launcher directly for other tools.

Cargo registry and Git downloads retain the user's existing CARGO_HOME. Do not
share writable caches across mutually untrusted users. Docker BuildKit caches
are separate and are not configured by this setup.

Use `scripts/chat-dev --isolated command ...` for worktree-local caches, including
Cargo downloads. The `target/chat-dev-isolated` directory is ignored. Existing CARGO_TARGET_DIR,
PLAYWRIGHT_BROWSERS_PATH, and npm_config_store_dir override shared defaults.
CHAT_DEV_CACHE_ROOT changes the shared root. CHAT_DEV_CACHE_MODE=isolated bypasses
the automatic shims; the normal tool defaults then apply.

Generated WASM bindings, web/dist, test reports, encrypted test state, ports, and
node_modules remain worktree-local. Do not symlink these between branches.

Legacy worktrees must receive the build-wasm.sh metadata fix before automatic
WASM target sharing is enabled. Native Cargo commands already share targets.
The shim warns and retains a local WASM target until then, because old scripts assume ./target. Other hard-coded target paths
in old test scripts must also be updated or run with CARGO_TARGET_DIR="$PWD/target".

Existing caches and artifacts are not moved or deleted. Reinstall dependencies
through the shim to populate the shared store. Remove old artifacts only after
checking that their worktree has no running jobs. This setup does not impose a
cache retention limit.

Checks: `python3 scripts/test-dev-caches.py` uses temporary caches and fake tools.
