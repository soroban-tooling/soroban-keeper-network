//! Network presets: RPC endpoint + passphrase for each Stellar network this
//! SDK targets. Mirrors the network-preset concept the TypeScript SDK's own
//! epic tracks (issue 0258, "network configuration presets for
//! testnet/futurenet/mainnet") so both SDKs agree on the same three networks
//! and the same canonical endpoints — a client shouldn't get a different
//! answer for "what's testnet's passphrase" depending on which SDK it uses.

/// A Stellar network this SDK can target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network {
    Testnet,
    Futurenet,
    Mainnet,
}

impl Network {
    /// The public Soroban RPC endpoint for this network.
    pub fn rpc_url(&self) -> &'static str {
        match self {
            Network::Testnet => "https://soroban-testnet.stellar.org",
            Network::Futurenet => "https://rpc-futurenet.stellar.org",
            Network::Mainnet => "https://mainnet.sorobanrpc.com",
        }
    }

    /// The network passphrase Soroban transactions on this network must be
    /// signed against.
    pub fn passphrase(&self) -> &'static str {
        match self {
            Network::Testnet => "Test SDF Network ; September 2015",
            Network::Futurenet => "Test SDF Future Network ; October 2022",
            Network::Mainnet => "Public Global Stellar Network ; September 2015",
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn testnet_uses_the_documented_public_endpoint_and_passphrase() {
        assert_eq!(
            Network::Testnet.rpc_url(),
            "https://soroban-testnet.stellar.org"
        );
        assert_eq!(
            Network::Testnet.passphrase(),
            "Test SDF Network ; September 2015"
        );
    }

    #[test]
    fn futurenet_uses_the_documented_public_endpoint_and_passphrase() {
        assert_eq!(
            Network::Futurenet.rpc_url(),
            "https://rpc-futurenet.stellar.org"
        );
        assert_eq!(
            Network::Futurenet.passphrase(),
            "Test SDF Future Network ; October 2022"
        );
    }

    #[test]
    fn mainnet_uses_the_documented_public_endpoint_and_the_classic_passphrase() {
        assert_eq!(Network::Mainnet.rpc_url(), "https://mainnet.sorobanrpc.com");
        assert_eq!(
            Network::Mainnet.passphrase(),
            "Public Global Stellar Network ; September 2015"
        );
    }

    #[test]
    fn every_network_has_a_distinct_passphrase_and_endpoint() {
        let all = [Network::Testnet, Network::Futurenet, Network::Mainnet];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a.rpc_url(), b.rpc_url(), "{a:?} and {b:?} share an RPC URL");
                assert_ne!(
                    a.passphrase(),
                    b.passphrase(),
                    "{a:?} and {b:?} share a passphrase"
                );
            }
        }
    }
}
