//! Rust client SDK for the Soroban keeper registry contract.
//!
//! See the crate [README](https://github.com/soroban-tooling/soroban-keeper-network/blob/main/rust-sdk/README.md)
//! for intended use cases and a getting-started example.

pub mod network;
pub mod retry;

pub use network::{CustomNetworkConfig, Network, NetworkConfig, FUTURENET, MAINNET, TESTNET};
pub use retry::{default_classify, ErrorClass, RetryPolicy, RpcCallError, TransportError};
//! Rust SDK for the Soroban Keeper Network contract.
//!
//! Provides lower-level cross-contract call builders for contracts calling the
//! keeper registry from within their own entry points without transaction-level
//! keypair or RPC signing dependencies.

pub mod cross_contract;

pub use cross_contract::{CrossContractInvocation, KeeperRegistryCrossContract};
