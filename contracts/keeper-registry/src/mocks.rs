//! A configurable reentrant reward-token mock, shared by the checks-
//! effects-interactions regression tests (`test/cancel.rs`, `test/expire.rs`)
//! and the `reentrancy` fuzz target (`fuzz/fuzz_targets/reentrancy.rs`).
//!
//! Wave 1's CEI-ordering fixes for `cancel_task` and `expire_task` each
//! hand-wrote a bespoke reentrant mock token contract inside their own test
//! file to prove one specific reentrancy scenario. This module replaces both
//! with a single `ReentrantToken` contract, configurable via `arm` with:
//! which registry entry point to re-call (`TARGET_*`), the arguments that
//! call needs, and whether the re-entrant call fires before or after this
//! token's own balance update (`POINT_*`) — configuration rather than
//! separate copy-pasted contracts. A fuzz target can then randomize which
//! payout path is targeted across a single run instead of needing a bespoke
//! target per function. See issue #203 / backlog 0056.

#![cfg(any(test, fuzzing))]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env};

use crate::KeeperRegistryClient;

/// Registry entry points this mock knows how to re-call. Covers every path
/// that calls `reward_token(&e)?.transfer(...)` out of the registry today.
pub const TARGET_CANCEL_TASK: u32 = 0;
pub const TARGET_EXPIRE_TASK: u32 = 1;
pub const TARGET_WITHDRAW_REWARDS: u32 = 2;
/// E06 (`docs/STAKING_DESIGN.md`) — see `test/staking.rs`'s
/// `test_reentrant_token_*` tests. These three reuse the `owner` slot in
/// `arm`'s fixed parameter list to carry the keeper address (stake
/// operations key off a keeper, not a task owner), and the `task_id: u64`
/// slot is unused by all three (amounts come from the registry's own
/// existing stake state at reentry time, not from a caller-supplied value,
/// since `stake_deposit`/`withdraw_stake`/`slash`'s own arguments are fixed
/// by the outer call that triggered the reentrant transfer in the first
/// place).
pub const TARGET_STAKE_DEPOSIT: u32 = 3;
pub const TARGET_WITHDRAW_STAKE: u32 = 4;
pub const TARGET_SLASH: u32 = 5;

/// At which point in this token's own `transfer` the re-entrant call fires.
pub const POINT_BEFORE_BALANCE_UPDATE: u32 = 0;
pub const POINT_AFTER_BALANCE_UPDATE: u32 = 1;

/// Sentinel for `reentry_error_code` meaning "no decoded `KeeperError`" —
/// the hook never fired, the re-entrant call succeeded, or the rejection
/// came from the host's own reentrancy protection rather than the
/// contract's own status guard.
pub const NO_ERROR_CODE: u32 = u32::MAX;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Balance(Address),
    Registry,
    TriggerTo,
    Target,
    Point,
    Owner,
    TaskId,
    Keeper,
    Armed,
    ReentryFired,
    ReentrySucceeded,
    ReentryErrorCode,
    CallCount,
}

#[contract]
pub struct ReentrantToken;

#[contractimpl]
impl ReentrantToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &(balance + amount));
    }

    /// Test-only convenience: this mock does not manage its own storage TTL
    /// the way a real SAC does, so a test that jumps the ledger sequence
    /// forward by a large amount (e.g. E06's unbonding delay,
    /// `docs/STAKING_DESIGN.md`) must explicitly keep this contract's own
    /// instance entry and the balance entries it is about to touch alive
    /// across that jump, or they archive before the test's next call. Only
    /// extends entries that already exist (a `holder` with no balance entry
    /// yet is left alone).
    pub fn extend_ttl_for_test(env: Env, holders: soroban_sdk::Vec<Address>, to_ledger: u32) {
        env.storage().instance().extend_ttl(to_ledger, to_ledger);
        for holder in holders.iter() {
            let key = DataKey::Balance(holder);
            if env.storage().persistent().has(&key) {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, to_ledger, to_ledger);
            }
        }
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    /// Arms the reentrancy hook: the next `transfer` whose `to` equals
    /// `trigger_to` re-calls `target` on `registry`, at `point` in this
    /// transfer's own logic. `owner` / `task_id` / `keeper` are the
    /// arguments that call needs — only the ones relevant to `target` are
    /// read, so callers pass whatever placeholder they like for the rest.
    #[allow(clippy::too_many_arguments)]
    pub fn arm(
        env: Env,
        registry: Address,
        trigger_to: Address,
        target: u32,
        point: u32,
        owner: Address,
        task_id: u64,
        keeper: Address,
    ) {
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::TriggerTo, &trigger_to);
        env.storage().instance().set(&DataKey::Target, &target);
        env.storage().instance().set(&DataKey::Point, &point);
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::TaskId, &task_id);
        env.storage().instance().set(&DataKey::Keeper, &keeper);
        env.storage().instance().set(&DataKey::Armed, &true);
        env.storage().instance().set(&DataKey::ReentryFired, &false);
        env.storage()
            .instance()
            .set(&DataKey::ReentrySucceeded, &false);
        env.storage()
            .instance()
            .set(&DataKey::ReentryErrorCode, &NO_ERROR_CODE);
        env.storage().instance().set(&DataKey::CallCount, &0u32);
    }

    /// Whether the re-entrant call actually fired (a `transfer` to
    /// `trigger_to` occurred while armed).
    pub fn reentry_fired(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::ReentryFired)
            .unwrap_or(false)
    }

    /// Whether the re-entrant call succeeded. A correct CEI ordering must
    /// never let this be `true`.
    pub fn reentry_succeeded(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::ReentrySucceeded)
            .unwrap_or(false)
    }

    /// The decoded `KeeperError` code from the re-entrant call, or
    /// `NO_ERROR_CODE` if it never fired, succeeded, or was rejected before
    /// reaching this contract's own logic (e.g. the host's reentrancy
    /// protection).
    pub fn reentry_error_code(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ReentryErrorCode)
            .unwrap_or(NO_ERROR_CODE)
    }

    /// Number of transfers this token made to `trigger_to` while armed.
    pub fn call_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CallCount)
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let armed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Armed)
            .unwrap_or(false);
        let should_fire = armed
            && env
                .storage()
                .instance()
                .get::<_, Address>(&DataKey::TriggerTo)
                .map(|trigger_to| trigger_to == to)
                .unwrap_or(false);

        if should_fire {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::CallCount)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::CallCount, &(count + 1));
            // Fire once: disarm before recursing so a bug that lets the
            // re-entrant call succeed can't recurse forever.
            env.storage().instance().set(&DataKey::Armed, &false);
        }

        let point: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Point)
            .unwrap_or(POINT_AFTER_BALANCE_UPDATE);

        if should_fire && point == POINT_BEFORE_BALANCE_UPDATE {
            reenter(&env);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &(to_balance + amount));

        if should_fire && point != POINT_BEFORE_BALANCE_UPDATE {
            reenter(&env);
        }
    }
}

// Kept outside the `#[contractimpl]` block above (rather than as an
// associated fn on `ReentrantToken`) so the macro never mistakes it for a
// contract entry point — every genuine entry point above takes `Env` by
// value, per the SDK's convention, while this helper only needs `&Env`.
fn reenter(env: &Env) {
    env.storage().instance().set(&DataKey::ReentryFired, &true);

    let registry: Address = env.storage().instance().get(&DataKey::Registry).unwrap();
    let target: u32 = env.storage().instance().get(&DataKey::Target).unwrap();
    let client = KeeperRegistryClient::new(env, &registry);

    let (succeeded, code) = match target {
        TARGET_CANCEL_TASK => {
            let owner: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
            let task_id: u64 = env.storage().instance().get(&DataKey::TaskId).unwrap();
            match client.try_cancel_task(&owner, &task_id) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        TARGET_EXPIRE_TASK => {
            let task_id: u64 = env.storage().instance().get(&DataKey::TaskId).unwrap();
            match client.try_expire_task(&task_id) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        TARGET_WITHDRAW_REWARDS => {
            let keeper: Address = env.storage().instance().get(&DataKey::Keeper).unwrap();
            match client.try_withdraw_rewards(&keeper) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        // E06 (`docs/STAKING_DESIGN.md`): `owner`'s slot carries the keeper
        // address (stake operations key off a keeper, not a task owner);
        // `task_id`'s slot doubles as the i128 amount for the two targets
        // that need one.
        TARGET_STAKE_DEPOSIT => {
            let keeper: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
            let amount: u64 = env.storage().instance().get(&DataKey::TaskId).unwrap();
            match client.try_stake_deposit(&keeper, &(amount as i128)) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        TARGET_WITHDRAW_STAKE => {
            let keeper: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
            match client.try_withdraw_stake(&keeper) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        TARGET_SLASH => {
            let keeper: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
            let admin: Address = env.storage().instance().get(&DataKey::Keeper).unwrap();
            let treasury: Address = env.storage().instance().get(&DataKey::TriggerTo).unwrap();
            // The reentrant call's own incident id — deliberately the same
            // fixed value `test_reentrant_token_slash` uses for the outer
            // call, so a correct CEI ordering (incident recorded before the
            // token transfer) rejects this as a duplicate.
            let incident_id = BytesN::from_array(env, &[9u8; 32]);
            match client.try_slash(
                &admin,
                &keeper,
                &100_000i128,
                &symbol_short!("fraud"),
                &incident_id,
                &treasury,
            ) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        _ => (false, NO_ERROR_CODE),
    };

    env.storage()
        .instance()
        .set(&DataKey::ReentrySucceeded, &succeeded);
    env.storage()
        .instance()
        .set(&DataKey::ReentryErrorCode, &code);
}
