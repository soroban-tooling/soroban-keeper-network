//! High-level typed client for the Treasury Soroban contract.
//!
//! Mirrors `rust-sdk/src/client.rs`'s `KeeperClient` shape and its
//! `try_*`-wrapped-in-`map_err(ClientError::ContractError)` error pattern.
//! (Note: issue 0200 originally specified a fully typed `SdkError::Contract`
//! variant carrying the decoded contract error; that was never actually built
//! for `KeeperClient` either — what exists today is `ClientError`, which
//! stringifies the decoded error via `Debug`. This client follows the pattern
//! that is actually in the codebase rather than the one originally proposed,
//! for consistency with `client.rs`.)

use crate::client::ClientError;
use crate::signing::TransactionSigner;
use soroban_sdk::{Address, Env, Vec};
pub use treasury::Recipient;

fn alloc_format_error<E: core::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

/// High-level client wrapping all treasury contract interactions.
pub struct TreasuryClient<'a, S: TransactionSigner> {
    pub env: &'a Env,
    pub contract_id: Address,
    pub signer: &'a S,
}

impl<'a, S: TransactionSigner> TreasuryClient<'a, S> {
    pub fn new(env: &'a Env, contract_id: Address, signer: &'a S) -> Self {
        Self {
            env,
            contract_id,
            signer,
        }
    }

    fn raw(&self) -> treasury::TreasuryClient<'_> {
        treasury::TreasuryClient::new(self.env, &self.contract_id)
    }

    /// Initialize the contract with an admin address and reward token.
    pub fn initialize(&self, reward_token: &Address) -> Result<(), ClientError> {
        self.raw()
            .try_initialize(&self.signer.address(), reward_token)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: register a new recipient with the given share (bps).
    pub fn add_recipient(&self, recipient: &Address, shares_bps: u32) -> Result<(), ClientError> {
        self.raw()
            .try_add_recipient(&self.signer.address(), recipient, &shares_bps)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: de-register a recipient. Its withdrawable balance survives.
    pub fn remove_recipient(&self, recipient: &Address) -> Result<(), ClientError> {
        self.raw()
            .try_remove_recipient(&self.signer.address(), recipient)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: change a registered recipient's share (bps).
    pub fn update_recipient_shares(
        &self,
        recipient: &Address,
        new_shares_bps: u32,
    ) -> Result<(), ClientError> {
        self.raw()
            .try_update_recipient_shares(&self.signer.address(), recipient, &new_shares_bps)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Fund and trigger a pro-rata distribution to every registered recipient.
    pub fn distribute(&self, amount: i128) -> Result<(), ClientError> {
        self.raw()
            .try_distribute(&self.signer.address(), &amount)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Pull the signer's own withdrawable balance as a recipient.
    pub fn withdraw(&self) -> Result<i128, ClientError> {
        self.raw()
            .try_withdraw(&self.signer.address())
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Emergency pause toggle.
    pub fn pause(&self) -> Result<(), ClientError> {
        self.raw()
            .try_pause(&self.signer.address())
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Emergency unpause toggle.
    pub fn unpause(&self) -> Result<(), ClientError> {
        self.raw()
            .try_unpause(&self.signer.address())
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Transfer the admin role. Requires the incoming admin's auth too.
    pub fn transfer_admin(&self, new_admin: &Address) -> Result<(), ClientError> {
        self.raw()
            .try_transfer_admin(&self.signer.address(), new_admin)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Swap the contract's installed WASM for `new_wasm_hash`.
    pub fn upgrade(&self, new_wasm_hash: &soroban_sdk::BytesN<32>) -> Result<(), ClientError> {
        self.raw()
            .try_upgrade(&self.signer.address(), new_wasm_hash)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    // ── Read-only views ──────────────────────────────────────────────────────
    // Views never error on the contract side, so these call the raw client
    // directly rather than through `try_*`/`ClientError`.

    pub fn admin(&self) -> Option<Address> {
        self.raw().admin()
    }

    pub fn is_paused(&self) -> bool {
        self.raw().is_paused()
    }

    pub fn reward_token_address(&self) -> Option<Address> {
        self.raw().reward_token_address()
    }

    pub fn recipients(&self) -> Vec<Recipient> {
        self.raw().recipients()
    }

    pub fn recipient_shares(&self, recipient: &Address) -> u32 {
        self.raw().recipient_shares(recipient)
    }

    pub fn recipient_balance(&self, recipient: &Address) -> i128 {
        self.raw().recipient_balance(recipient)
    }

    pub fn recipient_total_received(&self, recipient: &Address) -> i128 {
        self.raw().recipient_total_received(recipient)
    }

    pub fn total_distributed(&self) -> i128 {
        self.raw().total_distributed()
    }
}
