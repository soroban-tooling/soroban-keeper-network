//! Transaction signing trait and implementations (Issue #340).
//!
//! Abstracts cryptographic signing behind [`TransactionSigner`] so integrators
//! can use local keypairs, hardware wallets (HSM / Ledger), or remote KMS signing.

use soroban_sdk::Address;

/// Trait for signing transactions without exposing raw private keys.
pub trait TransactionSigner {
    /// Return the public account address of the signer.
    fn address(&self) -> Address;

    /// Sign a payload or envelope bytes and return the signature.
    fn sign_payload(&self, payload: &[u8]) -> Result<soroban_sdk::Bytes, SignerError>;
}

#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("Signing failed: {0}")]
    Failed(#[from] anyhow::Error),
    #[error("Invalid signer configuration")]
    InvalidConfig,
}

/// Default keypair-backed signer implementation for local development and testing.
pub struct KeypairSigner {
    address: Address,
}

impl KeypairSigner {
    pub fn new(address: Address) -> Self {
        Self { address }
    }
}

impl TransactionSigner for KeypairSigner {
    fn address(&self) -> Address {
        self.address.clone()
    }

    fn sign_payload(&self, payload: &[u8]) -> Result<soroban_sdk::Bytes, SignerError> {
        // In testing/local mock mode, return mock signature payload
        let mut bytes = soroban_sdk::Bytes::new(&self.address.env());
        for &b in payload {
            bytes.push_back(b);
        }
        Ok(bytes)
    }
}
