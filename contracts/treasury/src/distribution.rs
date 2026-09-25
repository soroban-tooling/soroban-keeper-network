//! Distribution and withdrawal — the treasury's fund-moving entry points.

use soroban_sdk::{contractimpl, Address, Env};

use crate::errors::TreasuryError;
use crate::events::*;
use crate::internal::*;
use crate::types::DataKey;
use crate::{Treasury, TreasuryArgs, TreasuryClient};

#[contractimpl]
impl Treasury {
    // ── distribute ───────────────────────────────────────────────────────────
    //
    // Permissionless: any caller may fund a distribution (mirrors
    // `register_task`'s permission model — the caller pays, not the admin).
    // `amount` is split pro-rata across every registered recipient's share of
    // the total shares currently registered, floor-rounded per recipient the
    // same way the registry's `split_reward` rounds fees down. Only the sum
    // actually credited is pulled from the caller — any rounding remainder
    // that floor division cannot allocate to a recipient is simply never
    // collected, rather than being pulled in and left stranded in the
    // contract.
    //
    // Blocked while paused: see the policy table on `pause`/`unpause` in
    // `admin.rs`.

    pub fn distribute(e: Env, caller: Address, amount: i128) -> Result<(), TreasuryError> {
        require_not_paused(&e)?;
        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }
        caller.require_auth();

        let list = recipient_list(&e);
        if list.is_empty() {
            return Err(TreasuryError::NoRecipients);
        }

        let mut total_shares: i128 = 0;
        for recipient in list.iter() {
            total_shares = total_shares
                .checked_add(recipient_shares(&e, &recipient) as i128)
                .ok_or(TreasuryError::ArithmeticOverflow)?;
        }
        if total_shares == 0 {
            return Err(TreasuryError::NoRecipients);
        }

        bump_instance(&e);

        // Effect before interaction: recipient balances (and the lifetime
        // total) are credited before the token is pulled in, so a reentrant
        // token callback during the transfer below can never observe a state
        // where funds moved but no recipient was credited.
        let mut credited_total: i128 = 0;
        for recipient in list.iter() {
            let shares = recipient_shares(&e, &recipient) as i128;
            if shares == 0 {
                continue;
            }
            let share_amount = amount
                .checked_mul(shares)
                .ok_or(TreasuryError::ArithmeticOverflow)?
                / total_shares;
            if share_amount == 0 {
                continue;
            }
            credit_recipient(&e, &recipient, share_amount)?;
            credited_total = credited_total
                .checked_add(share_amount)
                .ok_or(TreasuryError::ArithmeticOverflow)?;
            let running_total = accrue_total_distributed(&e, share_amount)?;
            emit_distributed(&e, &recipient, share_amount, running_total);
        }

        if credited_total > 0 {
            reward_token(&e)?.transfer(&caller, &e.current_contract_address(), &credited_total);
        }

        Ok(())
    }

    // ── withdraw ─────────────────────────────────────────────────────────────
    //
    // A recipient pulls its accrued balance. CEI-safe: the balance is zeroed
    // before the token transfer, mirroring `withdraw_rewards` in the registry.
    // Never blocked by pause — fund recovery, not new exposure.

    pub fn withdraw(e: Env, recipient: Address) -> Result<i128, TreasuryError> {
        recipient.require_auth();

        let key = DataKey::RecipientBalance(recipient.clone());
        let balance: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if balance <= 0 {
            return Err(TreasuryError::NoRewardsAvailable);
        }

        bump_instance(&e);
        e.storage().persistent().set(&key, &0i128);

        reward_token(&e)?.transfer(&e.current_contract_address(), &recipient, &balance);
        emit_withdrawn(&e, &recipient, balance);
        Ok(balance)
    }
}
