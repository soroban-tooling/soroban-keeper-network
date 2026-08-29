# keeper-registry-sdk (Rust)

Opens epic E13 (#265): a native Rust client for the `keeper-registry`
contract, for contract-to-contract integrations and native (non-WASM-host)
tooling that want typed access without going through the TypeScript SDK's
JS runtime.

**This crate is a scaffold.** It has no contract-specific methods yet — see
`src/lib.rs`'s module doc comment for what it does establish (workspace
membership, the RPC client dependency, the module layout) versus what's
still to come (the actual client methods, mirroring the TypeScript SDK's
shape as that epic lands).

## Build & test

This is a native crate — it does **not** require the `wasm32-unknown-unknown`
target (only `contracts/keeper-registry` does):

```sh
cargo build -p keeper-registry-sdk
cargo test -p keeper-registry-sdk
```

It's a workspace member, so `cargo build`/`cargo test --workspace` at the
repo root includes it automatically alongside the contract.

## RPC client choice

The acceptance criteria for #265 ask to survey what actually exists in the
Soroban ecosystem for a Rust RPC client, rather than hand-rolling RPC calls
or assuming a specific crate. Surveyed (as of August 2026):

| Crate | Status |
|-------|--------|
| **[`soroban-client`](https://crates.io/crates/soroban-client)** (repo: [`rahul-soshte/rs-soroban-client`](https://github.com/rahul-soshte/rs-soroban-client)) | Actively maintained, v0.5.9 (released Aug 26 2026). Wraps the Soroban RPC surface this crate will eventually need: `simulateTransaction`, `getLedgerEntries`, `sendTransaction`, `getTransaction`, `getEvents`, testnet friendbot funding. Apache-2.0. |
| A separate "official" Stellar Development Foundation Rust RPC crate | **Does not exist.** The `soroban-sdk`/`soroban-env-host` crates are the on-chain contract SDK, not an RPC client; `soroban-cli`/`stellar-cli` is a binary, not a library dependency. |

**Decision: `soroban-client`.** It's the closest thing to a standard, actively
maintained choice, and is already pinned in `Cargo.toml`. This scaffold
doesn't call it yet (no client methods exist), but the dependency is in
place so the next PR in this epic doesn't have to re-litigate the choice.

If a better-maintained or more official alternative emerges later, revisit
this table rather than silently drifting — the whole point of writing this
down is so the choice is a decision, not an accident.
