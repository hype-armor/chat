#!/usr/bin/env bash
# Prints the wasm-bindgen version pinned in Cargo.lock.
set -euo pipefail
cd "$(dirname "$0")/.."
grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p'
