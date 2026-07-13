#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Soroban Keeper Network — Build & Optimize
#
# Builds the KeeperRegistry contract for wasm32 in release mode and produces an
# optimized .wasm ready for deployment. Prefers the `stellar contract optimize`
# subcommand and falls back to `wasm-opt` if the CLI isn't installed.
#
# Usage:
#   ./scripts/optimize.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PACKAGE="keeper-registry"
WASM="target/wasm32-unknown-unknown/release/keeper_registry.wasm"
OPT="${WASM%.wasm}.optimized.wasm"

echo "▶ Building $PACKAGE (release, wasm32-unknown-unknown)…"
cargo build --release --locked --target wasm32-unknown-unknown --package "$PACKAGE"

if [ ! -f "$WASM" ]; then
  echo "✖ Expected artifact not found: $WASM" >&2
  exit 1
fi

echo "▶ Optimizing…"
if command -v stellar >/dev/null 2>&1; then
  stellar contract optimize --wasm "$WASM"
elif command -v soroban >/dev/null 2>&1; then
  soroban contract optimize --wasm "$WASM"
elif command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --strip-debug "$WASM" -o "$OPT"
else
  echo "✖ No optimizer found. Install the Stellar CLI or wasm-opt." >&2
  exit 1
fi

echo "✔ Done."
ls -lh "$WASM" "$OPT" 2>/dev/null || ls -lh "$WASM"
