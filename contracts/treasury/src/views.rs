//! Read-only views.
//!
//! These are simulated by clients for free and must stay side-effect-free —
//! in particular they never bump storage TTL, and never return
//! `NotInitialized`: an uninitialized treasury has an unambiguous, harmless
//! answer for every view below. Mirrors
//! `contracts/keeper-registry/src/views.rs`'s policy exactly.

use soroban_sdk::{contractimpl, Address, Env, Vec};

use crate::constants::*;
use crate::internal::*;
use crate::types::{DataKey, Recipient};
use crate::{Treasury, TreasuryArgs, TreasuryClient};

#[contractimpl]
impl Treasury {
    pub fn admin(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::Admin)
    }

    pub fn is_paused(e: Env) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn reward_token_address(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::RewardToken)
    }

    /// Every currently-registered recipient with its shares, in registration
    /// order.
    pub fn recipients(e: Env) -> Vec<Recipient> {
        let list = recipient_list(&e);
        let mut out = Vec::new(&e);
        for address in list.iter() {
            let shares_bps = recipient_shares(&e, &address);
            out.push_back(Recipient {
                address,
                shares_bps,
            });
        }
        out
    }

    /// A recipient's current share, in basis points (0 if not registered).
    pub fn recipient_shares(e: Env, recipient: Address) -> u32 {
        recipient_shares(&e, &recipient)
    }

    /// A recipient's withdrawable balance.
    pub fn recipient_balance(e: Env, recipient: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::RecipientBalance(recipient))
            .unwrap_or(0i128)
    }

    /// A recipient's lifetime total ever credited by `distribute`, including
    /// amounts already withdrawn.
    pub fn recipient_total_received(e: Env, recipient: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::RecipientReceivedTotal(recipient))
            .unwrap_or(0i128)
    }

    /// Lifetime total ever distributed to any recipient.
    pub fn total_distributed(e: Env) -> i128 {
        e.storage()
            .instance()
            .get(&DataKey::TotalDistributed)
            .unwrap_or(0i128)
    }

    /// Maximum number of recipients `distribute` will iterate. See
    /// [`MAX_RECIPIENTS`].
    pub fn max_recipients(_e: Env) -> u32 {
        MAX_RECIPIENTS
    }

    /// Contract logic version. See [`VERSION`].
    pub fn version(_e: Env) -> u32 {
        VERSION
    }
}
