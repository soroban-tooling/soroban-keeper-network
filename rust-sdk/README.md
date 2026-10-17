# soroban-keeper-sdk

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
soroban-keeper-sdk = "0.1"
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

* [`client::KeeperRegistryClient`](src/client.rs) — the network-facing client.
  It owns the simulate, sign, submit flow once (`read` / `write`) and every
  typed method (`get_task`, `get_fee_bps`, `is_paused`, `set_fee_bps`) is a
  thin wrapper over it. Contract types (`Task`, `TaskType`, `TaskStatus`) and
  errors (`KeeperError`, via `RegistryClientError::Contract`) are the
  `keeper_registry` types themselves. The RPC layer is the `RpcTransport`
  trait, because this crate bundles no HTTP client; implement it over your
  Soroban RPC node, or over an in-process `Env` as
  `tests/registry_client_tests.rs` does.

```rust,ignore
let client = KeeperRegistryClient::new(contract_id, rpc_url, passphrase, my_transport)
    .with_signer(signer);
let fee_bps = client.get_fee_bps().await?;
client.set_fee_bps(fee_bps + 50).await?;
```

Contract rejections (`RegistryClientError::Contract`) are never retried;
transport failures during simulation are retried per the `RetryPolicy`, and
submission is never retried, since a lost response may mean it already landed.

## Further reading

* [`docs/BATCH_OPERATIONS.md`](../docs/BATCH_OPERATIONS.md) — batch
  registration semantics and limits, shared with the contract and the other
  SDKs.
* The root [README](../README.md#events)'s event table — the events this
  crate's client will decode.
* Rustdoc (`cargo doc --open -p soroban-keeper-sdk`) for the current module reference.

## Releasing

1. Update `version` in `rust-sdk/Cargo.toml` and commit the change.
2. Dry-run the `keeper-treasury` and `keeper-registry` support packages, then
   run `cargo publish --dry-run --locked --manifest-path rust-sdk/Cargo.toml`.
   Before the first release, Cargo reports the support crates as missing from
   crates.io; use `cargo package --list --locked --manifest-path
   rust-sdk/Cargo.toml` to inspect the initial SDK package file set.
3. Create an annotated tag matching that version, for example
   `git tag -a rust-sdk-v0.2.0 -m "rust-sdk v0.2.0"`.
4. Push the tag. The `Publish Rust SDK` workflow checks that the tag and crate
   versions match, runs the SDK tests, publishes any missing versioned support
   crates in dependency order, verifies the SDK against crates.io, and then
   publishes the SDK.

The workflow reads the crates.io API token from the
`RUST_SDK_CRATES_IO_TOKEN` repository secret. The token must never be placed
in a tag, workflow input, command argument, or committed configuration file.
