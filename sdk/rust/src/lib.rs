//! Native Rust SDK for the Soroban Keeper Network's `keeper-registry` contract.
//!
//! Opened as a scaffold by epic E13 (#265): a Rust-native client for
//! contract-to-contract integrations and native (non-WASM-host) tooling that
//! want typed access to `keeper-registry` without going through the
//! TypeScript SDK's JS runtime. Issue #268 filled in the first real client
//! methods — see [`client::KeeperRegistryClient`] (the generic `invoke`/
//! `read` building blocks, mirroring the TypeScript SDK's own design) and
//! [`methods`] (the six task-lifecycle methods built on top of them).
//!
//! # Example
//! ```
//! use keeper_registry_sdk::network::Network;
//!
//! let net = Network::Testnet;
//! assert_eq!(net.rpc_url(), "https://soroban-testnet.stellar.org");
//! ```

pub mod client;
pub mod methods;
pub mod network;

pub use client::{ClientError, KeeperRegistryClient};
pub use network::Network;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_client::keypair::{Keypair, KeypairBehavior};

    #[test]
    fn constructs_a_client_without_any_network_access() {
        let keypair = Keypair::random().unwrap();
        let client = KeeperRegistryClient::new(
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
            Network::Testnet,
            keypair,
        )
        .unwrap();
        assert_eq!(
            client.contract_id(),
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
        );
        assert_eq!(*client.network(), Network::Testnet);
    }

    #[test]
    fn accepts_a_string_or_a_borrowed_str_for_contract_id() {
        let keypair = Keypair::random().unwrap();
        let owned = String::from("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
        let from_owned =
            KeeperRegistryClient::new(owned, Network::Futurenet, keypair.clone()).unwrap();
        let from_borrowed = KeeperRegistryClient::new(
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
            Network::Futurenet,
            keypair,
        )
        .unwrap();
        assert_eq!(from_owned.contract_id(), from_borrowed.contract_id());
    }
}
