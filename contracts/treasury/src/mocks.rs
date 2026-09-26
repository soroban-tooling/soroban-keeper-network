//! A configurable reentrant reward-token mock, for the checks-effects-
//! interactions regression test in `test/reentrancy.rs`.
//!
//! Mirrors `contracts/keeper-registry/src/mocks.rs::ReentrantToken` exactly —
//! same `arm`/`transfer` shape, same `POINT_*`/`TARGET_*` configuration
//! style — adapted to the treasury's own entry points and error type. See
//! that file's doc comment for the general design rationale.

#![cfg(any(test, fuzzing))]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

use crate::TreasuryClient;

/// Treasury entry points this mock knows how to re-call. Covers every path
/// that calls `reward_token(&e)?.transfer(...)` in the contract today.
pub const TARGET_DISTRIBUTE: u32 = 0;
pub const TARGET_WITHDRAW: u32 = 1;

/// At which point in this token's own `transfer` the re-entrant call fires.
pub const POINT_BEFORE_BALANCE_UPDATE: u32 = 0;
pub const POINT_AFTER_BALANCE_UPDATE: u32 = 1;

/// Sentinel for `reentry_error_code` meaning "no decoded `TreasuryError`" —
/// the hook never fired, the re-entrant call succeeded, or the rejection
/// came from the host's own reentrancy protection rather than the
/// contract's own status guard.
pub const NO_ERROR_CODE: u32 = u32::MAX;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Balance(Address),
    Treasury,
    TriggerTo,
    Target,
    Point,
    Caller,
    Recipient,
    Amount,
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

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    /// Arms the reentrancy hook: the next `transfer` whose `to` equals
    /// `trigger_to` re-calls `target` on `treasury`, at `point` in this
    /// transfer's own logic. `caller`/`recipient`/`amount` are the arguments
    /// that call needs — only the ones relevant to `target` are read, so
    /// callers pass whatever placeholder they like for the rest.
    #[allow(clippy::too_many_arguments)]
    pub fn arm(
        env: Env,
        treasury: Address,
        trigger_to: Address,
        target: u32,
        point: u32,
        caller: Address,
        recipient: Address,
        amount: i128,
    ) {
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage()
            .instance()
            .set(&DataKey::TriggerTo, &trigger_to);
        env.storage().instance().set(&DataKey::Target, &target);
        env.storage().instance().set(&DataKey::Point, &point);
        env.storage().instance().set(&DataKey::Caller, &caller);
        env.storage()
            .instance()
            .set(&DataKey::Recipient, &recipient);
        env.storage().instance().set(&DataKey::Amount, &amount);
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

    /// The decoded `TreasuryError` code from the re-entrant call, or
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

    let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
    let target: u32 = env.storage().instance().get(&DataKey::Target).unwrap();
    let client = TreasuryClient::new(env, &treasury);

    let (succeeded, code) = match target {
        TARGET_DISTRIBUTE => {
            let caller: Address = env.storage().instance().get(&DataKey::Caller).unwrap();
            let amount: i128 = env.storage().instance().get(&DataKey::Amount).unwrap();
            match client.try_distribute(&caller, &amount) {
                Ok(_) => (true, NO_ERROR_CODE),
                Err(Ok(err)) => (false, err as u32),
                Err(Err(_)) => (false, NO_ERROR_CODE),
            }
        }
        TARGET_WITHDRAW => {
            let recipient: Address = env.storage().instance().get(&DataKey::Recipient).unwrap();
            match client.try_withdraw(&recipient) {
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
