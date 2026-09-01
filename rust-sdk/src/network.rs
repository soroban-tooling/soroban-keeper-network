//! Named network presets.
//!
//! Mirrors the keeper-bot example's `NETWORK_CONFIG` map
//! (`examples/keeper-bot/index.js`) so a native application does not have to
//! hardcode Stellar's network passphrase strings, and so the two clients
//! cannot silently drift onto different values for the same network.

/// RPC endpoint and network passphrase for a Soroban network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkConfig {
    /// Soroban RPC URL to submit and simulate transactions against.
    pub rpc_url: &'static str,
    /// Network passphrase used to sign transactions for this network.
    pub network_passphrase: &'static str,
}

impl NetworkConfig {
    /// Use a preset's passphrase with a caller-supplied RPC URL — a
    /// self-hosted node or a regional provider — without forking the crate
    /// or needing a fourth preset variant per private node an integrator
    /// might run.
    pub fn with_rpc_url(&self, rpc_url: impl Into<String>) -> CustomNetworkConfig {
        CustomNetworkConfig {
            rpc_url: rpc_url.into(),
            network_passphrase: self.network_passphrase,
        }
    }
}

/// A [`NetworkConfig`] with the RPC URL overridden, keeping the preset's
/// passphrase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomNetworkConfig {
    pub rpc_url: String,
    pub network_passphrase: &'static str,
}

/// Stellar Test Network.
///
/// See <https://developers.stellar.org/docs/networks> for the current RPC
/// endpoints and passphrases — they are Stellar's, not this crate's, so this
/// preset tracks that page rather than asserting the values will never
/// change.
pub const TESTNET: NetworkConfig = NetworkConfig {
    rpc_url: "https://soroban-testnet.stellar.org",
    network_passphrase: "Test SDF Network ; September 2015",
};

/// Stellar Future Network (preview of upcoming protocol versions).
///
/// See <https://developers.stellar.org/docs/networks> for the current RPC
/// endpoints and passphrases.
pub const FUTURENET: NetworkConfig = NetworkConfig {
    rpc_url: "https://rpc-futurenet.stellar.org",
    network_passphrase: "Test SDF Future Network ; October 2022",
};

/// Stellar Public (main) Network.
///
/// See <https://developers.stellar.org/docs/networks> for the current RPC
/// endpoints and passphrases.
pub const MAINNET: NetworkConfig = NetworkConfig {
    rpc_url: "https://mainnet.sorobanrpc.com",
    network_passphrase: "Public Global Stellar Network ; September 2015",
};

/// The three named presets, plus an explicit custom variant for a caller's
/// own RPC endpoint (self-hosted node, regional provider) — so a private
/// node never needs a preset variant of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Network {
    Testnet,
    Futurenet,
    Mainnet,
    /// A fully caller-supplied endpoint and passphrase.
    Custom(CustomNetworkConfig),
}

impl Network {
    /// RPC URL this variant resolves to.
    pub fn rpc_url(&self) -> String {
        match self {
            Network::Testnet => TESTNET.rpc_url.to_string(),
            Network::Futurenet => FUTURENET.rpc_url.to_string(),
            Network::Mainnet => MAINNET.rpc_url.to_string(),
            Network::Custom(c) => c.rpc_url.clone(),
        }
    }

    /// Network passphrase this variant resolves to.
    pub fn network_passphrase(&self) -> &str {
        match self {
            Network::Testnet => TESTNET.network_passphrase,
            Network::Futurenet => FUTURENET.network_passphrase,
            Network::Mainnet => MAINNET.network_passphrase,
            Network::Custom(c) => c.network_passphrase,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_match_keeper_bot_network_config_exactly() {
        // Cross-referenced against `examples/keeper-bot/index.js`'s
        // `NETWORK_CONFIG`.
        assert_eq!(TESTNET.rpc_url, "https://soroban-testnet.stellar.org");
        assert_eq!(
            TESTNET.network_passphrase,
            "Test SDF Network ; September 2015"
        );

        assert_eq!(FUTURENET.rpc_url, "https://rpc-futurenet.stellar.org");
        assert_eq!(
            FUTURENET.network_passphrase,
            "Test SDF Future Network ; October 2022"
        );

        assert_eq!(MAINNET.rpc_url, "https://mainnet.sorobanrpc.com");
        assert_eq!(
            MAINNET.network_passphrase,
            "Public Global Stellar Network ; September 2015"
        );
    }

    #[test]
    fn custom_rpc_url_keeps_the_preset_passphrase() {
        let custom = TESTNET.with_rpc_url("https://my-node.example.com");
        assert_eq!(custom.rpc_url, "https://my-node.example.com");
        assert_eq!(custom.network_passphrase, TESTNET.network_passphrase);
    }

    #[test]
    fn network_enum_resolves_each_variant() {
        assert_eq!(Network::Testnet.rpc_url(), TESTNET.rpc_url);
        assert_eq!(
            Network::Mainnet.network_passphrase(),
            MAINNET.network_passphrase
        );

        let custom = Network::Custom(TESTNET.with_rpc_url("https://my-node.example.com"));
        assert_eq!(custom.rpc_url(), "https://my-node.example.com");
        assert_eq!(custom.network_passphrase(), TESTNET.network_passphrase);
    }
}
