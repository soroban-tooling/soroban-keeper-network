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
Issue #268 filled in the first real client methods: [`KeeperRegistryClient`](src/client.rs)
(the generic `invoke`/`read` building blocks — simulate → sign → send →
poll for state-changing calls, simulate-only for reads) and the six
task-lifecycle methods built on top of them in [`methods.rs`](src/methods.rs)
(`register_task`, `claim_task`, `execute_task`, `cancel_task`,
`expire_task`, `withdraw_rewards`), mirroring `contracts/keeper-registry/src/task.rs`'s
own function signatures. Argument/return encoding is verified directly
against `stellar-xdr` 27.0.0's `ScVal` enum rather than assumed — see
`methods.rs`'s own doc comment for the specifics.

Issues #266/#269 separately settled this crate's async-vs-sync and
contract/network error-handling design — see [`DESIGN.md`](DESIGN.md) and
[`src/keeper_error.rs`](src/keeper_error.rs)'s `KeeperSdkError` (distinct
from [`methods::SdkError`](src/methods.rs), which wraps `ClientError`; see
either type's doc comment for how they relate).

```rust,no_run
use keeper_registry_sdk::{KeeperRegistryClient, Network};
use keeper_registry_sdk::methods::TaskType;
use soroban_client::keypair::{Keypair, KeypairBehavior};

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let keypair = Keypair::from_secret("SB...")?;
let client = KeeperRegistryClient::new(
    "CONTRACT_ID_HERE",
    Network::Testnet,
    keypair,
)?;

let task_id = client
    .register_task(
        "GOWNER...",
        TaskType::Liquidation,
        b"calldata",
        1_000_000,
        /* deadline */ 0,
        /* ttl_ledgers */ 100,
        /* lock_ledgers */ 10,
    )
    .await?;
# Ok(())
# }
```

Full lifecycle tests (`tests/lifecycle.rs`) run against a mocked Soroban
RPC server rather than a live network — see that file's own doc comment
for why, and for how to point `KeeperRegistryClient::with_rpc_url` at a
local sandbox/quickstart node instead if a real, on-chain end-to-end test
is ever needed.

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
