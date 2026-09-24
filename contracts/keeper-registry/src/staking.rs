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

use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::constants::*;
use crate::errors::KeeperError;
use crate::events::*;
use crate::internal::*;
use crate::types::{DataKey, PendingCredit, SlashRecord, UnbondRequest};
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
        require_initialized(&e)?;
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
        require_initialized(&e)?;
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
        require_initialized(&e)?;
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
    // check to trigger this from). Moves `amount` of `keeper`'s collateral
    // to `treasury`, exactly the destination pattern `sweep_fees` already
    // uses for protocol fees. `amount` can never exceed the keeper's total
    // slashable exposure. Returns a `slash_id` for later reference by
    // `raise_slash_appeal`.
    //
    // Slashable exposure is `KeeperStake` *plus* any amount sitting in a
    // pending `UnbondRequest`, not `KeeperStake` alone (security review
    // finding, docs/STAKING_SECURITY_REVIEW.md "Unbonding as a slash-evasion
    // path"): `initiate_unbond` moves funds out of `KeeperStake` and into
    // `UnbondRequest` immediately, well before `UNBOND_DELAY_LEDGERS`
    // elapses, so treating only `KeeperStake` as slashable let a keeper
    // evade a slash entirely by front-running it with an unbond call — the
    // funds are still fully within this contract's custody and have not
    // become withdrawable, so slashing them is not "taking a stake that no
    // longer applies," it is closing exactly the gap collateral exists to
    // close. Drawn from `KeeperStake` first, then from the pending unbond
    // amount for any remainder still needed; a fully-consumed unbond
    // request is removed, a partially-consumed one has its amount reduced
    // (its `unlock_ledger` is untouched — slashing does not change when the
    // rest becomes withdrawable).

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

        let stake_key = DataKey::KeeperStake(keeper.clone());
        let current_stake = keeper_stake_of(&e, &keeper);

        let unbond_key = DataKey::UnbondRequest(keeper.clone());
        let pending_unbond: Option<UnbondRequest> = e.storage().persistent().get(&unbond_key);
        let pending_unbond_amount = pending_unbond.as_ref().map_or(0, |r| r.amount);

        let total_slashable = current_stake
            .checked_add(pending_unbond_amount)
            .ok_or(KeeperError::ArithmeticOverflow)?;
        if amount > total_slashable {
            return Err(KeeperError::InsufficientStake);
        }

        bump_instance(&e);

        // Effects before interaction. Draw from KeeperStake first...
        let from_stake = amount.min(current_stake);
        let remaining_stake = current_stake
            .checked_sub(from_stake)
            .ok_or(KeeperError::ArithmeticOverflow)?;
        e.storage().persistent().set(&stake_key, &remaining_stake);
        e.storage().persistent().extend_ttl(
            &stake_key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        // ...then whatever remainder is still needed from the pending
        // unbond, if any (from_unbond is 0, and this block a no-op, in the
        // common case where KeeperStake alone covers the slash).
        let from_unbond = amount
            .checked_sub(from_stake)
            .ok_or(KeeperError::ArithmeticOverflow)?;
        if from_unbond > 0 {
            // from_unbond > 0 implies total_slashable > current_stake, which
            // implies pending_unbond_amount > 0, which implies pending_unbond
            // is Some — but per issue #441's no-panicking-expects discipline,
            // this still returns a typed error rather than asserting it,
            // exactly like dispute_execution's credits.get(index) above.
            let mut request = pending_unbond.ok_or(KeeperError::ArithmeticOverflow)?;
            let remaining_unbond = request
                .amount
                .checked_sub(from_unbond)
                .ok_or(KeeperError::ArithmeticOverflow)?;
            if remaining_unbond == 0 {
                e.storage().persistent().remove(&unbond_key);
            } else {
                request.amount = remaining_unbond;
                e.storage().persistent().set(&unbond_key, &request);
                e.storage().persistent().extend_ttl(
                    &unbond_key,
                    KEEPER_BALANCE_BUMP_THRESHOLD,
                    KEEPER_BALANCE_BUMP_LEDGERS,
                );
            }
        }

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

        // Security review finding (docs/STAKING_SECURITY_REVIEW.md, "Appeal
        // never renews TTL"): this state-mutating write previously called
        // neither bump_instance nor extend_ttl on the Slash record it just
        // updated, unlike every other staking entry point that mutates
        // persistent state. A prompt appeal (well within
        // DISPUTE_WINDOW_LEDGERS of the slash) relied entirely on the
        // original `slash` call's TTL bump to keep both the instance and
        // this record alive until resolve_slash_appeal ran — with no
        // deadline on how long the admin may take to resolve an appeal,
        // that original bump could lapse first, archiving the whole
        // registry (not just this record) and leaving a legitimately-raised
        // appeal permanently unresolvable.
        bump_instance(&e);
        record.appealed = true;
        e.storage().persistent().set(&record_key, &record);
        e.storage().persistent().extend_ttl(
            &record_key,
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

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

    // ── set_dispute_window ───────────────────────────────────────────────────
    //
    // Admin sets how long (in ledgers) an execute_task credit is held
    // before it becomes withdrawable (docs/STAKING_DESIGN.md §4.2). Default
    // 0 (disabled) is the unmodified wave-1 MVP behavior — a credit is
    // immediately withdrawable. Capped at MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS
    // for the same instance-TTL-outliving reason UNBOND_DELAY_LEDGERS is
    // bounded (§3). Only affects credits from executions after this call;
    // already-pending credits keep the unlock_ledger they were given.

    pub fn set_dispute_window(e: Env, admin: Address, ledgers: u32) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if ledgers > MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS {
            return Err(KeeperError::InvalidTaskParams);
        }
        bump_instance(&e);
        let old_ledgers = dispute_window_ledgers(&e);
        e.storage()
            .instance()
            .set(&DataKey::DisputeWindowLedgers, &ledgers);
        emit_dispute_window_updated(&e, old_ledgers, ledgers);
        Ok(())
    }

    // ── dispute_execution ────────────────────────────────────────────────────
    //
    // The task's owner (only — mirrors cancel_task's owner-only
    // authorization) disputes an executed task's still-pending credit,
    // before it finalizes into the keeper's withdrawable balance. See
    // docs/STAKING_DESIGN.md §4.2.

    pub fn dispute_execution(e: Env, owner: Address, task_id: u64) -> Result<(), KeeperError> {
        owner.require_auth();

        let task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        let keeper = task.claimer.clone().ok_or(KeeperError::NoPendingCredit)?;

        let mut credits = pending_credits_of(&e, &keeper);
        let index = credits
            .iter()
            .position(|c| c.task_id == task_id)
            .ok_or(KeeperError::NoPendingCredit)?;
        // `index` came directly from `.position()` on this same `credits`
        // Vec, so `.get(index)` can never actually miss — but issue #441's
        // no-panicking-expects discipline treats every unwrap as one to
        // remove regardless of whether it's currently provably unreachable,
        // so this still returns a typed error rather than asserting it away.
        let mut credit = credits
            .get(index as u32)
            .ok_or(KeeperError::NoPendingCredit)?;

        if credit.disputed {
            return Err(KeeperError::ExecutionAlreadyDisputed);
        }
        // `>=`, not `>`: security review finding
        // (docs/STAKING_SECURITY_REVIEW.md, "Dispute-window boundary
        // mismatch"). `finalize_rewards` (via `withdraw_rewards`) considers
        // a credit finalizable once `now >= credit.unlock_ledger` —
        // mirroring `lock_expired`'s established "has this delay window
        // elapsed" convention — so a credit sitting at exactly
        // `unlock_ledger` was simultaneously still disputable under the old
        // `>` check here and already finalizable there: whichever
        // transaction actually landed first within that one ledger decided
        // the outcome, rather than a deterministic rule. Closing the
        // dispute window at the same boundary finalization opens at removes
        // that race entirely.
        if e.ledger().sequence() >= credit.unlock_ledger {
            return Err(KeeperError::DisputeWindowClosed);
        }

        bump_instance(&e);
        credit.disputed = true;
        credits.set(index as u32, credit);
        e.storage()
            .persistent()
            .set(&DataKey::PendingReward(keeper.clone()), &credits);
        e.storage().persistent().extend_ttl(
            &DataKey::PendingReward(keeper.clone()),
            KEEPER_BALANCE_BUMP_THRESHOLD,
            KEEPER_BALANCE_BUMP_LEDGERS,
        );

        emit_execution_disputed(&e, task_id, &keeper);
        Ok(())
    }

    // ── resolve_execution_dispute ────────────────────────────────────────────
    //
    // Admin-only. `uphold_dispute = true` removes the pending credit
    // without ever crediting KeeperReward — the reward is simply never
    // paid; the admin is expected to follow up with a separate `slash`
    // call if the underlying misbehavior warrants it (docs/STAKING_DESIGN.md
    // §4.2 — this is deliberate, not an oversight: no auto-slash). `false`
    // clears the disputed flag, returning the credit to the normal
    // finalization path once its unlock_ledger passes.

    pub fn resolve_execution_dispute(
        e: Env,
        admin: Address,
        task_id: u64,
        uphold_dispute: bool,
    ) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;

        let task = load_task(&e, task_id)?;
        let keeper = task.claimer.clone().ok_or(KeeperError::NoDisputedCredit)?;

        let credits = pending_credits_of(&e, &keeper);
        let index = credits
            .iter()
            .position(|c| c.task_id == task_id && c.disputed)
            .ok_or(KeeperError::NoDisputedCredit)?;

        bump_instance(&e);

        let mut remaining: Vec<PendingCredit> = Vec::new(&e);
        let mut forfeited: i128 = 0;
        for (i, c) in credits.iter().enumerate() {
            if i == index {
                if uphold_dispute {
                    // Dispute upheld: the keeper is never paid. The credit's
                    // net_reward was already carved out of the task's escrow
                    // at execute_task time (the task left `Pending`/`Claimed`,
                    // so `open_escrow` no longer counts it), and the tokens
                    // never left the contract, so dropping the credit here
                    // with no further bookkeeping would strand them
                    // permanently: uncounted by KeeperReward, KeeperStake,
                    // PendingReward, or FeesAccrued, in violation of I-1
                    // (docs/ARCHITECTURE.md). There is no principled way to
                    // refund the task owner (register_task's escrow
                    // accounting already closed out at execution), so the
                    // forfeited amount accrues to the protocol fee pot,
                    // exactly like a rejected slash appeal's stake accrues
                    // to the treasury rather than evaporating.
                    forfeited = forfeited
                        .checked_add(c.net_reward)
                        .ok_or(KeeperError::ArithmeticOverflow)?;
                } else {
                    // Dispute rejected: clear the flag and keep the credit,
                    // eligible to finalize normally once its unlock_ledger
                    // passes (which may already have happened while the
                    // dispute was pending).
                    let mut c = c;
                    c.disputed = false;
                    remaining.push_back(c);
                }
            } else {
                remaining.push_back(c);
            }
        }

        let key = DataKey::PendingReward(keeper.clone());
        if remaining.is_empty() {
            e.storage().persistent().remove(&key);
        } else {
            e.storage().persistent().set(&key, &remaining);
            e.storage().persistent().extend_ttl(
                &key,
                KEEPER_BALANCE_BUMP_THRESHOLD,
                KEEPER_BALANCE_BUMP_LEDGERS,
            );
        }

        if forfeited > 0 {
            accrue_fee(&e, forfeited)?;
        }

        emit_execution_dispute_resolved(&e, task_id, uphold_dispute);
        Ok(())
    }
}
