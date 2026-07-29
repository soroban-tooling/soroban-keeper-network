---
title: "feat(sdk-rust): scaffold the Rust SDK crate"
labels: [tooling, enhancement, intermediate]
epic: E13
wave: 3
depends_on: []
---

## Summary

Opens epic E13. A Rust-native client is useful for contract-to-contract integrations and native (non-WASM-host) tooling that wants typed access to the keeper-registry contract without going through the TypeScript SDK's JS runtime. This issue scaffolds a new crate with no contract-specific logic yet, alongside the existing `contracts/keeper-registry` crate in the workspace.

## Expected behaviour

A new `sdk/rust/` (or `crates/keeper-registry-sdk/`, pick one convention consistent with how `contracts/` and `fuzz/` are already organized) crate added to the workspace, depending on `soroban-sdk` and a Soroban RPC client crate (survey what exists in the Soroban ecosystem for this -- `soroban-client` or equivalent -- rather than hand-rolling RPC calls from scratch), with a placeholder module and a passing `cargo test`.

## Acceptance criteria

- [ ] Crate builds as part of the existing workspace `cargo build`/`cargo test` without requiring the `wasm32-unknown-unknown` target (it's a native client, not a contract).
- [ ] CI gets a job building and testing this crate, consistent with the existing `Tests (required)` job's scope.
- [ ] A decision on the RPC client dependency is made and documented, surveying what actually exists and is maintained in the Soroban ecosystem rather than assumed.

## Files

- sdk/rust/Cargo.toml
- sdk/rust/src/lib.rs
- Cargo.toml
- .github/workflows/ci.yml
