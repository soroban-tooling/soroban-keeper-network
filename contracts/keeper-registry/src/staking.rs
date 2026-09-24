//! Keeper staking and slashing (epic E06). See `docs/STAKING_DESIGN.md` for
//! the full design: trigger model, storage layout, and the decisions this
//! module implements against.
//!
//! Covers backlog issues 0289 (stake storage / `stake_deposit`), 0290
//! (unbonding: `initiate_unbond` / `withdraw_stake`), and 0291 (`slash`).

use soroban_sdk::{contractimpl, Address, BytesN, Env, Symbol};

use crate::constants::{KEEPER_STAKE_BUMP_LEDGERS, KEEPER_STAKE_BUMP_THRESHOLD, UNBOND_DELAY_LEDGERS};
use crate::errors::KeeperError;
use crate::events::*;
use crate::internal::*;
use crate::types::{DataKey, UnbondRequest};
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

#[contractimpl]
impl KeeperRegistry {
    // ── stake_deposit ────────────────────────────────────────────────────────
    //
    // A keeper posts collateral. Requires the depositing keeper's own auth —
    // no address can stake on behalf of another. Independent of task escrow
    // and reward balances: staking, executing tasks, and withdrawing rewards
    // never interfere with each other's storage (see test/staking.rs).

    pub fn stake_deposit(e: Env, keeper: Address, amount: i128) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        if amount <= 0 {
            return Err(KeeperError::InvalidStakeAmount);
        }
        keeper.require_auth();

        bump_instance(&e);
        let current = read_keeper_stake(&e, &keeper);
        let new_total = current
            .checked_add(amount)
            .ok_or(KeeperError::ArithmeticOverflow)?;

        // Effects before interaction.
        write_keeper_stake(&e, &keeper, new_total);
        reward_token(&e)?.transfer(&keeper, &e.current_contract_address(), &amount);

        emit_stake_deposited(&e, &keeper, amount, new_total);
        Ok(())
    }

    // ── initiate_unbond ──────────────────────────────────────────────────────
    //
    // Starts the unbonding delay for `amount` of the keeper's stake. A second
    // call while one request is already pending replaces it, using the new
    // total (docs/STAKING_DESIGN.md §3) — not additive, so a keeper who
    // changes their mind about how much to unbond does not need to wait out
    // an old, smaller request first.
    //
    // No token transfer here — the stake stays escrowed in the contract
    // (still slashable, still counted in I-1 solvency) until `withdraw_stake`
    // actually releases it. This is bookkeeping only.

    pub fn initiate_unbond(e: Env, keeper: Address, amount: i128) -> Result<u32, KeeperError> {
        require_not_paused(&e)?;
        if amount <= 0 {
            return Err(KeeperError::InvalidStakeAmount);
        }
        keeper.require_auth();

        let current_stake = read_keeper_stake(&e, &keeper);
        if amount > current_stake {
            return Err(KeeperError::InsufficientStake);
        }

        bump_instance(&e);
        let release_ledger = e
            .ledger()
            .sequence()
            .checked_add(UNBOND_DELAY_LEDGERS)
            .ok_or(KeeperError::ArithmeticOverflow)?;

        let key = DataKey::UnbondRequest(keeper.clone());
        e.storage().persistent().set(
            &key,
            &UnbondRequest {
                amount,
                release_ledger,
            },
        );
        e.storage()
            .persistent()
            .extend_ttl(&key, KEEPER_STAKE_BUMP_THRESHOLD, KEEPER_STAKE_BUMP_LEDGERS);

        emit_unbond_initiated(&e, &keeper, amount, release_ledger);
        Ok(release_ledger)
    }

    // ── withdraw_stake ───────────────────────────────────────────────────────
    //
    // Releases a keeper's pending unbond request once its delay has elapsed
    // (inclusive boundary: `>=`, matching `lock_expired`'s existing
    // convention). Reduces both the pending request and the underlying
    // KeeperStake balance by the same amount, then transfers the tokens out.

    pub fn withdraw_stake(e: Env, keeper: Address) -> Result<i128, KeeperError> {
        keeper.require_auth();

        let key = DataKey::UnbondRequest(keeper.clone());
        let request: UnbondRequest = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(KeeperError::NoUnbondRequest)?;

        if e.ledger().sequence() < request.release_ledger {
            return Err(KeeperError::UnbondNotReady);
        }

        let current_stake = read_keeper_stake(&e, &keeper);
        // Defensive: a concurrent slash could have reduced the stake below
        // the pending unbond amount since initiate_unbond ran. Release only
        // what remains rather than underflowing.
        let amount = request.amount.min(current_stake);

        bump_instance(&e);
        // Effects before interaction.
        e.storage().persistent().remove(&key);
        write_keeper_stake(&e, &keeper, current_stake - amount);

        if amount > 0 {
            reward_token(&e)?.transfer(&e.current_contract_address(), &keeper, &amount);
        }

        emit_stake_withdrawn(&e, &keeper, amount);
        Ok(amount)
    }

    // ── slash ─────────────────────────────────────────────────────────────────
    //
    // Admin-triggered stake reduction (docs/STAKING_DESIGN.md §1 — v1 is
    // admin-only, not automatic, not dispute-based). `incident_id` provides
    // incident-level idempotency (§6): the same incident can never be
    // slashed twice. `amount` must not exceed the keeper's current stake —
    // rejected outright rather than clamped (§1's "Slash bounds decision"),
    // so the admin always knows exactly what happened. Slashed funds move to
    // `treasury`, a caller-supplied parameter per call, mirroring
    // `sweep_fees`'s existing shape rather than introducing a stored
    // treasury-address configuration value.

    pub fn slash(
        e: Env,
        admin: Address,
        keeper: Address,
        amount: i128,
        reason: Symbol,
        incident_id: BytesN<32>,
        treasury: Address,
    ) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;

        if amount <= 0 {
            return Err(KeeperError::InvalidStakeAmount);
        }

        let incident_key = DataKey::SlashIncident(incident_id.clone());
        if e.storage().persistent().has(&incident_key) {
            return Err(KeeperError::DuplicateSlashIncident);
        }

        let current_stake = read_keeper_stake(&e, &keeper);
        if amount > current_stake {
            return Err(KeeperError::SlashExceedsStake);
        }

        bump_instance(&e);
        // Effects before interaction: record the incident and the reduced
        // stake before the token ever leaves the contract, so a reentrant
        // call (from a malicious reward-token `transfer`) sees the incident
        // already recorded and the stake already reduced — it cannot slash
        // the same incident twice or double-count the reduction.
        e.storage().persistent().set(&incident_key, &());
        e.storage().persistent().extend_ttl(
            &incident_key,
            KEEPER_STAKE_BUMP_THRESHOLD,
            KEEPER_STAKE_BUMP_LEDGERS,
        );
        write_keeper_stake(&e, &keeper, current_stake - amount);

        reward_token(&e)?.transfer(&e.current_contract_address(), &treasury, &amount);

        emit_slashed(&e, &keeper, amount, reason, &incident_id, &treasury);
        Ok(())
    }

    // ── Read-only views ──────────────────────────────────────────────────────
    // Never bump storage TTL, matching views.rs's existing policy.

    /// A keeper's current bonded stake (0 if never deposited or fully
    /// withdrawn). Does not include any amount currently mid-unbond — that
    /// amount is still part of this total until `withdraw_stake` actually
    /// releases it (still slashable, still counted in I-1 solvency).
    pub fn keeper_stake(e: Env, keeper: Address) -> i128 {
        read_keeper_stake(&e, &keeper)
    }

    /// A keeper's pending unbond request, if any: `(amount, release_ledger)`.
    pub fn unbonding_status(e: Env, keeper: Address) -> Option<(i128, u32)> {
        let request: Option<UnbondRequest> = e
            .storage()
            .persistent()
            .get(&DataKey::UnbondRequest(keeper));
        request.map(|r| (r.amount, r.release_ledger))
    }

    /// Whether `incident_id` has already been slashed against.
    pub fn is_slash_incident_recorded(e: Env, incident_id: BytesN<32>) -> bool {
        e.storage()
            .persistent()
            .has(&DataKey::SlashIncident(incident_id))
    }
}
