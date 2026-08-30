//! Native Rust SDK for the Soroban Keeper Network's `keeper-registry` contract.
//!
//! Opens epic E13 (#265): a Rust-native client for contract-to-contract
//! integrations and native (non-WASM-host) tooling that want typed access to
//! `keeper-registry` without going through the TypeScript SDK's JS runtime.
//!
//! This crate is currently a SCAFFOLD — no contract method wrappers yet
//! (that's future work in this epic, issue #269 onward). It exists to:
//!   - land in the workspace as a native (non-wasm32) crate, verified by CI
//!     alongside the existing `Tests (required)` job;
//!   - pin the RPC client dependency (see "RPC client choice" in this
//!     crate's README.md) so later work building out the actual client
//!     methods doesn't have to re-litigate that choice;
//!   - establish the error strategy (see [`error::SdkError`] and
//!     `DESIGN.md`) every future method in this crate will return, decided
//!     up front so method-wrapper PRs don't each need to re-litigate it;
//!   - establish the module layout future PRs (client methods, typed event
//!     decoders, etc. — mirroring the TypeScript SDK's shape) will fill in.
//!
//! # Example
//! ```
//! use keeper_registry_sdk::network::Network;
//!
//! let net = Network::Testnet;
//! assert_eq!(net.rpc_url(), "https://soroban-testnet.stellar.org");
//! ```

pub mod error;
pub mod network;

pub use error::{CallError, ErrorContext, SdkError};
pub use network::Network;

/// Placeholder for the contract client this crate will eventually provide —
/// see the module doc comment. Exists now so downstream code (and this
/// crate's own tests) have a concrete type to grow, rather than every PR in
/// this epic needing to introduce the type itself.
#[derive(Debug, Clone)]
pub struct KeeperRegistryClient {
    /// The contract id this client talks to (a `C...` strkey).
    pub contract_id: String,
    /// Which network (and therefore which RPC endpoint) this client targets.
    pub network: Network,
}

impl KeeperRegistryClient {
    /// Construct a client for `contract_id` on `network`. Does not perform
    /// any network I/O — connecting/simulating happens on first real call,
    /// once this crate grows one.
    pub fn new(contract_id: impl Into<String>, network: Network) -> Self {
        Self {
            contract_id: contract_id.into(),
            network,
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn constructs_a_client_without_any_network_access() {
        let client = KeeperRegistryClient::new(
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
            Network::Testnet,
        );
        assert_eq!(
            client.contract_id,
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
        );
        assert_eq!(client.network, Network::Testnet);
    }

    #[test]
    fn accepts_a_string_or_a_borrowed_str_for_contract_id() {
        let owned = String::from("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
        let from_owned = KeeperRegistryClient::new(owned, Network::Futurenet);
        let from_borrowed = KeeperRegistryClient::new(
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
            Network::Futurenet,
        );
        assert_eq!(from_owned.contract_id, from_borrowed.contract_id);
    }
}
