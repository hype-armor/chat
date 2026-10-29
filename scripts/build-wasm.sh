#!/usr/bin/env bash
# Builds the Rust core to WebAssembly and generates JS bindings for the web
# client. Output: web/src/core/pkg (git-ignored).
#
# Requires: rustup target wasm32-unknown-unknown, and wasm-bindgen-cli at the
# same version as the wasm-bindgen crate in Cargo.lock:
#   cargo install wasm-bindgen-cli --locked --version "$(scripts/wasm-bindgen-version.sh)"
set -euo pipefail
cd "$(dirname "$0")/.."

profile="${1:-release}"
cargo build --profile "$profile" --target wasm32-unknown-unknown -p chat-core --features wasm
wasm-bindgen --target web --out-dir web/src/core/pkg \
  "target/wasm32-unknown-unknown/$profile/chat_core.wasm"

# Optional size optimisation when binaryen's wasm-opt is installed.
if command -v wasm-opt >/dev/null; then
  wasm-opt -Os --enable-bulk-memory --enable-nontrapping-float-to-int \
    -o web/src/core/pkg/chat_core_bg.wasm web/src/core/pkg/chat_core_bg.wasm
fi
ls -l web/src/core/pkg/chat_core_bg.wasm
