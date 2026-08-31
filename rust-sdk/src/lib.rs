//! Rust SDK for the Soroban Keeper Network contract.
//!
//! Provides lower-level cross-contract call builders for contracts calling the
//! keeper registry from within their own entry points without transaction-level
//! keypair or RPC signing dependencies.

pub mod cross_contract;

pub use cross_contract::{CrossContractInvocation, KeeperRegistryCrossContract};
