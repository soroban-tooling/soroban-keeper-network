# keeper-sdk

A Rust client SDK for the [Soroban keeper registry contract](../contracts/keeper-registry).

## Who this is for

This crate targets **native applications and contract-to-contract calls**:
long-running keeper bots, backend services, and other Rust or Soroban code
that wants to register, claim, and execute keeper tasks without shelling out
to a CLI or embedding a JS runtime.

If you're building a browser dashboard or a Node.js service instead, use the
TypeScript SDK — it targets that environment and speaks the same contract.

## Installation

```toml
[dependencies]
keeper-sdk = { git = "https://github.com/soroban-tooling/soroban-keeper-network", package = "keeper-sdk" }
```

## What's here today

* [`network`](src/network.rs) — named presets (`Network::Testnet`,
  `Network::Futurenet`, `Network::Mainnet`) carrying the RPC URL and network
  passphrase for each Stellar network, plus `Network::Custom` for a
  self-hosted node or regional provider. These match the keeper-bot example's
  `NETWORK_CONFIG` exactly.
* [`retry`](src/retry.rs) — a configurable [`RetryPolicy`] for the transient
  RPC failures a client hits (timeouts, dropped connections, a simulation
  endpoint that's temporarily down), applied only around the RPC call itself.
  A decoded contract error (`KeeperError`, e.g. `NotTaskClaimer`) is never
  retried — the contract already ran and already rejected it, so retrying
  wastes a submission attempt that can never succeed. See the module docs for
  the full reasoning, ported from the keeper-bot example's `withRetry` /
  `isPermanentError`.

```rust
use keeper_sdk::{Network, RetryPolicy};
use std::time::Duration;

let network = Network::Testnet;
let policy = RetryPolicy {
    max_attempts: 5,
    base_delay: Duration::from_millis(250),
    ..RetryPolicy::default()
};

println!("{} @ {}", network.rpc_url(), network.network_passphrase());
```

The transaction-building client itself (`register_task` and friends) is not
yet published from this crate — track its progress in the repository's issue
tracker. Once it lands, a minimal `register_task` example will replace this
section, and full method documentation will live in rustdoc.

## Further reading

* [`docs/BATCH_OPERATIONS.md`](../docs/BATCH_OPERATIONS.md) — batch
  registration semantics and limits, shared with the contract and the other
  SDKs.
* The root [README](../README.md#events)'s event table — the events this
  crate's client will decode.
* Rustdoc (`cargo doc --open -p keeper-sdk`) for the current module reference.
