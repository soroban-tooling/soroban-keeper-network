//! Staking, unbonding, and slashing entry points (epic E06).
//!
//! Implements `docs/STAKING_DESIGN.md`: a keeper posts collateral separate
//! from its reward balance (`DataKey::KeeperStake`, never conflated with
//! `DataKey::KeeperReward` — the same separation-of-concerns reasoning that
//! already keeps `FeesAccrued` distinct from task escrow), can request to
//! unbond it after a configured delay, and an admin can slash a keeper's
//! stake for off-chain-determined misbehavior, moving the slashed amount to
//! a treasury address exactly like `sweep_fees` already does for protocol
//! fees. A slashed keeper has a fixed post-slash window to appeal; the admin
//! resolves the appeal by upholding it (refunding the stake) or rejecting it
//! (the slash stands).

use soroban_sdk::{contractimpl, Address, Env, Symbol};

use crate::constants::*;
use crate::errors::KeeperError;
use crate::events::*;
use crate::internal::*;
use crate::types::{DataKey, SlashRecord, UnbondRequest};
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

#[contractimpl]
impl KeeperRegistry {
    // ── stake_deposit ────────────────────────────────────────────────────────
    //
    // A keeper posts collateral. Requires the keeper's own auth — no address
    // can stake on behalf of another. Escrows `amount` from the keeper into
    // the contract via the same reward-token client every other transfer in
    // this contract uses.

    pub fn stake_deposit(e: Env, keeper: Address, amount: i128) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        if amount <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        keeper.require_auth();
        bump_instance(&e);

        let key = DataKey::KeeperStake(keeper.clone());
        let current = keeper_stake_of(&e, &keeper);
        let updated = current
            .checked_add(amount)
            .ok_or(KeeperError::ArithmeticOverflow)?;

        // Effects before interaction.
        e.storage().persistent().set(&key, &updated);
        e.storage().persistent().extend_ttl(
            &key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        reward_token(&e)?.transfer(&keeper, &e.current_contract_address(), &amount);

        emit_stake_deposited(&e, &keeper, amount, updated);
        Ok(())
    }

    // ── initiate_unbond ──────────────────────────────────────────────────────
    //
    // Starts the unbonding delay for `amount` of a keeper's stake. Only one
    // unbond request may be pending per keeper at a time (a second call
    // while one is outstanding is rejected, not merged or overwritten) —
    // withdraw the first before starting another.

    pub fn initiate_unbond(e: Env, keeper: Address, amount: i128) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        if amount <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        keeper.require_auth();

        let current_stake = keeper_stake_of(&e, &keeper);
        if amount > current_stake {
            return Err(KeeperError::InsufficientStake);
        }

        let request_key = DataKey::UnbondRequest(keeper.clone());
        if e.storage().persistent().has(&request_key) {
            return Err(KeeperError::UnbondAlreadyPending);
        }

        bump_instance(&e);

        // The unbonding amount leaves the "effective" stake immediately —
        // `keeper_stake_of` (and therefore the `set_min_stake` gate on
        // `claim_task`, docs/STAKING_DESIGN.md §6) reflects only what is
        // still fully bonded, not what is mid-unbond.
        let stake_key = DataKey::KeeperStake(keeper.clone());
        let remaining = current_stake
            .checked_sub(amount)
            .ok_or(KeeperError::ArithmeticOverflow)?;
        e.storage().persistent().set(&stake_key, &remaining);
        e.storage().persistent().extend_ttl(
            &stake_key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        let unlock_ledger = e.ledger().sequence().saturating_add(UNBOND_DELAY_LEDGERS);
        let request = UnbondRequest {
            amount,
            unlock_ledger,
        };
        e.storage().persistent().set(&request_key, &request);
        e.storage().persistent().extend_ttl(
            &request_key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        emit_unbond_initiated(&e, &keeper, amount, unlock_ledger);
        Ok(())
    }

    // ── withdraw_stake ───────────────────────────────────────────────────────
    //
    // Releases a keeper's pending unbond request once the delay has elapsed.
    // The boundary is inclusive — at exactly `unlock_ledger`, the request is
    // already withdrawable (`>=`, not `>`), mirroring `lock_expired`'s
    // boundary convention. Returns the amount withdrawn.

    pub fn withdraw_stake(e: Env, keeper: Address) -> Result<i128, KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        let request_key = DataKey::UnbondRequest(keeper.clone());
        let request: UnbondRequest = e
            .storage()
            .persistent()
            .get(&request_key)
            .ok_or(KeeperError::NoPendingUnbond)?;

        if e.ledger().sequence() < request.unlock_ledger {
            return Err(KeeperError::UnbondNotReady);
        }

        bump_instance(&e);

        // Effects before interaction: the request is cleared before the
        // transfer, so a re-entrant reward token cannot withdraw twice.
        e.storage().persistent().remove(&request_key);

        reward_token(&e)?.transfer(&e.current_contract_address(), &keeper, &request.amount);

        emit_stake_withdrawn(&e, &keeper, request.amount);
        Ok(request.amount)
    }

    // ── slash ─────────────────────────────────────────────────────────────────
    //
    // Admin-authorized (docs/STAKING_DESIGN.md §4-5 — dispute-based, not
    // automatic: E04's verifier work never landed, so there is no on-chain
    // check to trigger this from). Moves `amount` of `keeper`'s current
    // stake to `treasury`, exactly the destination pattern `sweep_fees`
    // already uses for protocol fees. `amount` can never exceed the
    // keeper's current stake. Returns a `slash_id` for later reference by
    // `raise_slash_appeal`.

    pub fn slash(
        e: Env,
        admin: Address,
        keeper: Address,
        amount: i128,
        reason: Symbol,
        treasury: Address,
    ) -> Result<u64, KeeperError> {
        require_admin(&e, &admin)?;

        if amount <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        let current_stake = keeper_stake_of(&e, &keeper);
        if amount > current_stake {
            return Err(KeeperError::InsufficientStake);
        }

        bump_instance(&e);

        // Effects before interaction.
        let stake_key = DataKey::KeeperStake(keeper.clone());
        let remaining = current_stake
            .checked_sub(amount)
            .ok_or(KeeperError::ArithmeticOverflow)?;
        e.storage().persistent().set(&stake_key, &remaining);
        e.storage().persistent().extend_ttl(
            &stake_key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        let slash_id = next_slash_id(&e);
        let record = SlashRecord {
            keeper: keeper.clone(),
            amount,
            reason: reason.clone(),
            ledger: e.ledger().sequence(),
            appealed: false,
        };
        let record_key = DataKey::Slash(slash_id);
        e.storage().persistent().set(&record_key, &record);
        e.storage().persistent().extend_ttl(
            &record_key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        reward_token(&e)?.transfer(&e.current_contract_address(), &treasury, &amount);

        emit_slashed(&e, slash_id, &keeper, amount, &reason);
        Ok(slash_id)
    }

    // ── set_min_stake ─────────────────────────────────────────────────────────
    //
    // Admin sets the minimum bonded stake `claim_task` requires. Default 0
    // (no requirement), mirroring `set_min_reward`'s pattern for the
    // task-side floor. Existing claims are unaffected; only future
    // `claim_task` calls are validated.

    pub fn set_min_stake(e: Env, admin: Address, min_stake: i128) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if min_stake < 0 {
            return Err(KeeperError::InvalidReward);
        }
        bump_instance(&e);
        let old_min = min_stake_floor(&e);
        e.storage().instance().set(&DataKey::MinStake, &min_stake);
        emit_min_stake_updated(&e, old_min, min_stake);
        Ok(())
    }

    // ── raise_slash_appeal ───────────────────────────────────────────────────
    //
    // Only the slashed keeper itself has standing to appeal its own slash
    // (docs/STAKING_DESIGN.md §4.1). Must be called within
    // `DISPUTE_WINDOW_LEDGERS` of the slash, and at most once per
    // `slash_id`. Raising an appeal does not by itself reverse anything —
    // it flags the record for the admin to resolve via
    // `resolve_slash_appeal`.

    pub fn raise_slash_appeal(e: Env, keeper: Address, slash_id: u64) -> Result<(), KeeperError> {
        keeper.require_auth();

        let record_key = DataKey::Slash(slash_id);
        let mut record: SlashRecord = e
            .storage()
            .persistent()
            .get(&record_key)
            .ok_or(KeeperError::SlashNotFound)?;

        if record.keeper != keeper {
            return Err(KeeperError::NotSlashedKeeper);
        }
        if record.appealed {
            return Err(KeeperError::AppealAlreadyRaised);
        }
        let appeal_deadline = record.ledger.saturating_add(DISPUTE_WINDOW_LEDGERS);
        if e.ledger().sequence() > appeal_deadline {
            return Err(KeeperError::AppealWindowClosed);
        }

        record.appealed = true;
        e.storage().persistent().set(&record_key, &record);

        emit_slash_appeal_raised(&e, slash_id, &keeper);
        Ok(())
    }

    // ── resolve_slash_appeal ─────────────────────────────────────────────────
    //
    // Admin-only. `slash` already moved the disputed amount out of this
    // contract to the treasury address the admin chose at slash time — this
    // contract does not hold it in escrow while an appeal is pending (see
    // docs/STAKING_DESIGN.md §4.1: a post-slash appeal, not a pre-slash
    // hold). Upholding an appeal is therefore a genuine refund, not an
    // internal bookkeeping reversal: the admin must supply the funds being
    // returned, exactly as `stake_deposit` requires the depositing party to
    // authorize and fund its own transfer. `uphold_appeal = true` pulls
    // `record.amount` from `admin` into the contract and credits it back to
    // the keeper's stake; `uphold_appeal = false` leaves the slash standing
    // with no transfer. Either way the appeal is considered resolved and
    // the record is removed, so it cannot be re-resolved.

    pub fn resolve_slash_appeal(
        e: Env,
        admin: Address,
        slash_id: u64,
        uphold_appeal: bool,
    ) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;

        let record_key = DataKey::Slash(slash_id);
        let record: SlashRecord = e
            .storage()
            .persistent()
            .get(&record_key)
            .ok_or(KeeperError::SlashNotFound)?;

        if !record.appealed {
            return Err(KeeperError::SlashNotFound);
        }

        bump_instance(&e);

        // Effects before interaction: the record is removed (so a second
        // resolution attempt fails the same "not found" way a
        // never-appealed id would) before the refund transfer runs.
        e.storage().persistent().remove(&record_key);

        if uphold_appeal {
            let stake_key = DataKey::KeeperStake(record.keeper.clone());
            let current = keeper_stake_of(&e, &record.keeper);
            let restored = current
                .checked_add(record.amount)
                .ok_or(KeeperError::ArithmeticOverflow)?;
            e.storage().persistent().set(&stake_key, &restored);
            e.storage().persistent().extend_ttl(
                &stake_key,
                KEEPER_BALANCE_BUMP_THRESHOLD,
                KEEPER_BALANCE_BUMP_LEDGERS,
            );

            reward_token(&e)?.transfer(&admin, &e.current_contract_address(), &record.amount);
        }

        emit_slash_appeal_resolved(&e, slash_id, uphold_appeal);
        Ok(())
    }
}
