//! Administrative entry points: configuration, recipient management, the
//! pause switch, admin transfer, and the upgrade hook.

use soroban_sdk::{contractimpl, log, Address, BytesN, Env};

use crate::constants::*;
use crate::errors::TreasuryError;
use crate::events::*;
use crate::internal::*;
use crate::types::DataKey;
use crate::{Treasury, TreasuryArgs, TreasuryClient};

#[contractimpl]
impl Treasury {
    // ── initialize ────────────────────────────────────────────────────────────
    //
    // Fully implemented. Call once after deployment.

    pub fn initialize(e: Env, admin: Address, reward_token: Address) -> Result<(), TreasuryError> {
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(TreasuryError::AlreadyInitialized);
        }
        admin.require_auth();

        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        e.storage().instance().set(&DataKey::Paused, &false);
        bump_instance(&e);

        emit_initialized(&e, &admin, &reward_token);
        Ok(())
    }

    // ── add_recipient / remove_recipient / update_recipient_shares ──────────
    //
    // Admin-only recipient-configuration entry points. Not gated by pause —
    // pausing doesn't restrict what the admin itself can do, the same rule
    // the registry's admin entry points follow.

    pub fn add_recipient(
        e: Env,
        admin: Address,
        recipient: Address,
        shares_bps: u32,
    ) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        if shares_bps == 0 || shares_bps > MAX_SHARES_BPS {
            return Err(TreasuryError::InvalidShares);
        }
        let mut list = recipient_list(&e);
        if list.iter().any(|a| a == recipient) {
            return Err(TreasuryError::RecipientAlreadyExists);
        }
        if list.len() >= MAX_RECIPIENTS {
            return Err(TreasuryError::TooManyRecipients);
        }
        bump_instance(&e);

        list.push_back(recipient.clone());
        e.storage().instance().set(&DataKey::RecipientList, &list);
        e.storage()
            .persistent()
            .set(&DataKey::RecipientShares(recipient.clone()), &shares_bps);
        e.storage().persistent().extend_ttl(
            &DataKey::RecipientShares(recipient.clone()),
            RECIPIENT_BALANCE_BUMP_THRESHOLD,
            RECIPIENT_BALANCE_BUMP_LEDGERS,
        );

        emit_recipient_added(&e, &recipient, shares_bps);
        Ok(())
    }

    pub fn remove_recipient(
        e: Env,
        admin: Address,
        recipient: Address,
    ) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        let mut list = recipient_list(&e);
        let Some(idx) = list.iter().position(|a| a == recipient) else {
            return Err(TreasuryError::RecipientNotFound);
        };
        bump_instance(&e);

        list.remove(idx as u32);
        e.storage().instance().set(&DataKey::RecipientList, &list);
        // Shares are zeroed (rather than removing the storage entry) so
        // `recipient_shares` — and therefore `distribute` — immediately stops
        // crediting a removed recipient. Balance and lifetime-received totals
        // are left untouched: a removed recipient can still `withdraw`
        // whatever it already earned.
        e.storage()
            .persistent()
            .set(&DataKey::RecipientShares(recipient.clone()), &0u32);

        emit_recipient_removed(&e, &recipient);
        Ok(())
    }

    pub fn update_recipient_shares(
        e: Env,
        admin: Address,
        recipient: Address,
        new_shares_bps: u32,
    ) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        if new_shares_bps == 0 || new_shares_bps > MAX_SHARES_BPS {
            return Err(TreasuryError::InvalidShares);
        }
        let list = recipient_list(&e);
        if !list.iter().any(|a| a == recipient) {
            return Err(TreasuryError::RecipientNotFound);
        }
        bump_instance(&e);

        let old_shares_bps = recipient_shares(&e, &recipient);
        e.storage().persistent().set(
            &DataKey::RecipientShares(recipient.clone()),
            &new_shares_bps,
        );

        emit_recipient_shares_updated(&e, &recipient, old_shares_bps, new_shares_bps);
        Ok(())
    }

    // ── pause / unpause ───────────────────────────────────────────────────────
    //
    // Admin emergency circuit breaker (issue: does the treasury need one?).
    // Decision: yes — mirroring the registry's blocked-versus-allowed split.
    // `distribute` opens new exposure (crediting recipients against a
    // configuration that may since have been discovered to be wrong or
    // compromised), so it is blocked. `withdraw` only lets a recipient pull a
    // balance it already earned — fund recovery, never blocked, so a pause
    // can never itself become a fund freeze. Read-only views are never gated.
    //
    // | Entry point               | While paused | Why                              |
    // |----------------------------|--------------|-----------------------------------|
    // | `distribute`               | BLOCKED      | opens new recipient exposure      |
    // | `withdraw`                 | allowed      | recipient pulling already-earned  |
    // |                            |              | balance; liveness, not new        |
    // |                            |              | exposure                          |
    // | `add_recipient`            | allowed      | admin-only (`require_admin`);     |
    // | `remove_recipient`         |              | pausing doesn't restrict what the |
    // | `update_recipient_shares`  |              | admin itself can do               |
    // | `transfer_admin`           | allowed      | same reason                       |
    // | `upgrade`                  | allowed      | same reason                       |
    // | read-only views            | allowed      | side-effect-free, never gated      |

    pub fn pause(e: Env, admin: Address) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Paused, &true);
        emit_paused(&e, true);
        Ok(())
    }

    pub fn unpause(e: Env, admin: Address) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Paused, &false);
        emit_paused(&e, false);
        Ok(())
    }

    // ── transfer_admin ────────────────────────────────────────────────────────
    //
    // Both the current admin and the incoming admin must authorize, so the
    // role can never be transferred to an address that has not consented to
    // take it.

    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        new_admin.require_auth();
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        emit_admin_transferred(&e, &admin, &new_admin);
        Ok(())
    }

    // ── upgrade ───────────────────────────────────────────────────────────────
    //
    // Admin swaps the contract WASM for a new hash (already installed
    // on-chain). Storage layout is preserved across the upgrade — matches the
    // registry's own `upgrade` entry point exactly (same signature, same
    // admin gate, same event-before-swap ordering).

    pub fn upgrade(e: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        bump_instance(&e);

        // Emitted before the wasm swap, for the same reason the registry's
        // `upgrade` does this: once `update_current_contract_wasm` runs, the
        // rest of this invocation continues under the new code's semantics.
        emit_upgraded(&e, &admin, &new_wasm_hash);

        e.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        log!(&e, "Contract upgraded by {} to {:?}", admin, new_wasm_hash);
        Ok(())
    }
}
