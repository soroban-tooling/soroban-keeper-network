//! Internal helpers shared by the contract's entry points.
//!
//! Nothing here is part of the published ABI. Mirrors
//! `contracts/keeper-registry/src/internal.rs`.

use soroban_sdk::{token, Address, Env, Vec};

use crate::constants::*;
use crate::errors::TreasuryError;
use crate::types::DataKey;

/// Renews instance-storage TTL. Called from every state-mutating entry point,
/// never from read-only views.
pub(crate) fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
}

pub(crate) fn require_not_paused(e: &Env) -> Result<(), TreasuryError> {
    if e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
    {
        Err(TreasuryError::ContractPaused)
    } else {
        Ok(())
    }
}

pub(crate) fn require_admin(e: &Env, caller: &Address) -> Result<(), TreasuryError> {
    let admin: Address = e
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(TreasuryError::NotInitialized)?;
    caller.require_auth();
    if *caller != admin {
        return Err(TreasuryError::Unauthorized);
    }
    Ok(())
}

pub(crate) fn recipient_list(e: &Env) -> Vec<Address> {
    e.storage()
        .instance()
        .get(&DataKey::RecipientList)
        .unwrap_or(Vec::new(e))
}

pub(crate) fn recipient_shares(e: &Env, recipient: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&DataKey::RecipientShares(recipient.clone()))
        .unwrap_or(0u32)
}

pub(crate) fn reward_token(e: &Env) -> Result<token::Client<'_>, TreasuryError> {
    let addr: Address = e
        .storage()
        .instance()
        .get(&DataKey::RewardToken)
        .ok_or(TreasuryError::NotInitialized)?;
    Ok(token::Client::new(e, &addr))
}

/// Adds `amount` to a recipient's withdrawable balance and lifetime-received
/// total. Shared by `distribute` (credit) and the source of truth for
/// `withdraw`. Kept as a single helper so the CEI invariant lives in one
/// place, mirroring `keeper-registry::internal::credit_keeper`.
pub(crate) fn credit_recipient(
    e: &Env,
    recipient: &Address,
    amount: i128,
) -> Result<(), TreasuryError> {
    let balance_key = DataKey::RecipientBalance(recipient.clone());
    let current: i128 = e.storage().persistent().get(&balance_key).unwrap_or(0);
    let updated = current
        .checked_add(amount)
        .ok_or(TreasuryError::ArithmeticOverflow)?;
    e.storage().persistent().set(&balance_key, &updated);
    e.storage().persistent().extend_ttl(
        &balance_key,
        RECIPIENT_BALANCE_BUMP_THRESHOLD,
        RECIPIENT_BALANCE_BUMP_LEDGERS,
    );

    let received_key = DataKey::RecipientReceivedTotal(recipient.clone());
    let current_received: i128 = e.storage().persistent().get(&received_key).unwrap_or(0);
    let updated_received = current_received
        .checked_add(amount)
        .ok_or(TreasuryError::ArithmeticOverflow)?;
    e.storage()
        .persistent()
        .set(&received_key, &updated_received);
    e.storage().persistent().extend_ttl(
        &received_key,
        RECIPIENT_BALANCE_BUMP_THRESHOLD,
        RECIPIENT_BALANCE_BUMP_LEDGERS,
    );

    Ok(())
}

/// Adds `amount` to the lifetime `TotalDistributed` accumulator.
pub(crate) fn accrue_total_distributed(e: &Env, amount: i128) -> Result<i128, TreasuryError> {
    let current: i128 = e
        .storage()
        .instance()
        .get(&DataKey::TotalDistributed)
        .unwrap_or(0);
    let updated = current
        .checked_add(amount)
        .ok_or(TreasuryError::ArithmeticOverflow)?;
    e.storage()
        .instance()
        .set(&DataKey::TotalDistributed, &updated);
    Ok(updated)
}
