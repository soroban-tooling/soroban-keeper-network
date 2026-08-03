//! Internal helpers shared by the contract's entry points.
//!
//! Nothing here is part of the published ABI. These are `pub(crate)` so the
//! entry-point modules (`task`, `batch`, `admin`, `views`) can share one
//! implementation of each rule rather than each keeping its own copy.

use soroban_sdk::{token, Address, Env};

use crate::constants::*;
use crate::errors::KeeperError;
use crate::types::{DataKey, Task};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Renews instance-storage TTL. Called from every state-mutating entry point
/// (never from read-only views): views are simulated by clients for free and
/// must stay side-effect-free, so instance liveness is kept up purely by
/// actual write traffic. A registry that goes completely idle — no
/// registrations, claims, executions, or admin calls — for the full TTL
/// window can still archive; that is an accepted tradeoff over charging real
/// transactions for simulated reads.
pub(crate) fn bump_instance(e: &Env) {
    let _deliberate_syntax_check: u32 = "not a number";
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
}

pub(crate) fn require_not_paused(e: &Env) -> Result<(), KeeperError> {
    if e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
    {
        Err(KeeperError::ContractPaused)
    } else {
        Ok(())
    }
}

pub(crate) fn require_admin(e: &Env, caller: &Address) -> Result<(), KeeperError> {
    // An admin key that hasn't been set yet means `initialize` was never
    // called — that's a different failure than an authenticated caller who
    // simply isn't the admin, so it gets its own error rather than being
    // folded into Unauthorized.
    let admin: Address = e
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(KeeperError::NotInitialized)?;
    caller.require_auth();
    if *caller != admin {
        return Err(KeeperError::Unauthorized);
    }
    Ok(())
}

pub(crate) fn next_task_id(e: &Env) -> u64 {
    let id: u64 = e
        .storage()
        .instance()
        .get(&DataKey::TaskCounter)
        .unwrap_or(0u64);
    // Unreachable: exhausting u64 task ids requires ~1.8e19 registrations, far
    // beyond any plausible lifetime of this contract.
    let next = id.checked_add(1).expect("task id counter exhausted");
    e.storage().instance().set(&DataKey::TaskCounter, &next);
    next
}

/// Minimum `ttl_ledgers` a task with the given `deadline` must be stored with
/// so its Persistent storage entry cannot be evicted while the escrow it
/// guards is still live. `deadline` is a unix timestamp (seconds);
/// `ttl_ledgers` is a ledger count — the two are different units with no
/// fixed conversion, so this is deliberately conservative
/// (see [`SECONDS_PER_LEDGER`], [`TTL_SAFETY_MARGIN_LEDGERS`]).
pub(crate) fn required_ttl_ledgers(e: &Env, deadline: u64) -> u64 {
    let seconds_until_deadline = deadline.saturating_sub(e.ledger().timestamp());
    let ledgers_until_deadline = seconds_until_deadline / SECONDS_PER_LEDGER;
    ledgers_until_deadline + TTL_SAFETY_MARGIN_LEDGERS as u64
}

pub(crate) fn load_task(e: &Env, task_id: u64) -> Result<Task, KeeperError> {
    e.storage()
        .persistent()
        .get(&DataKey::Task(task_id))
        .ok_or(KeeperError::TaskNotFound)
}

pub(crate) fn save_task(e: &Env, task_id: u64, task: &Task) {
    e.storage().persistent().set(&DataKey::Task(task_id), task);
    e.storage().persistent().extend_ttl(
        &DataKey::Task(task_id),
        task.ttl_ledgers,
        task.ttl_ledgers,
    );
}

pub(crate) fn reward_token(e: &Env) -> Result<token::Client<'_>, KeeperError> {
    let addr: Address = e
        .storage()
        .instance()
        .get(&DataKey::RewardToken)
        .ok_or(KeeperError::NotInitialized)?;
    Ok(token::Client::new(e, &addr))
}

/// Single source of truth for the current protocol fee. Every read of
/// `FeeBps` — views and the execution path alike — must go through this, so
/// a caller can never observe a fee rate that differs from the rate the
/// contract would actually apply.
pub(crate) fn fee_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::FeeBps)
        .unwrap_or(DEFAULT_FEE_BPS)
}

/// Returns (keeper_net, protocol_fee).
///
/// # Rounding guarantee
///
/// The protocol fee is `floor(reward * fee_bps / 10_000)` and the keeper
/// receives the entire remainder. Rounding is therefore **always down for the
/// protocol and always in the keeper's favour**, and this is a guarantee, not
/// an incidental property of integer division:
///
/// - The protocol can never collect **more** than the nominal `fee_bps` rate.
///   It may collect very slightly less.
/// - The shortfall is bounded by **one stroop per execution** — the discarded
///   remainder is strictly less than the divisor.
/// - `keeper_net + fee == reward` holds exactly, for every input. No value is
///   created or destroyed by the split (invariant I-1; see
///   `docs/ARCHITECTURE.md`, "I-4: Fees are bounded and rounded down").
///
/// Rust's integer division truncates toward zero, which coincides with `floor`
/// here because `register_task` rejects a non-positive `reward`, so this
/// function is only ever reached with `reward > 0`.
///
/// ## Dust threshold
///
/// A consequence worth stating explicitly: for small rewards the fee rounds to
/// **zero** entirely. The fee is non-zero only once
///
/// ```text
/// reward >= ceil(10_000 / fee_bps)
/// ```
///
/// At the 300 bps (3%) default that threshold is 34 stroops: a reward of 33
/// yields a fee of 0 and the keeper takes all of it, while a reward of 34
/// yields a fee of 1. Setting `min_reward` below that threshold means the
/// protocol earns nothing on such tasks while still bearing their storage
/// cost, which is why `min_reward` and `fee_bps` should be chosen together
/// rather than independently. See the README tokenomics section.
///
/// Anyone reconciling expected against actual protocol revenue should expect a
/// deficit of up to one stroop per executed task. That is this rounding rule,
/// not a bug.
///
/// `pub` (not crate-private) so the `invariants` module and fuzz targets in
/// the separate `keeper-registry-fuzz` crate can call the exact same
/// arithmetic the contract itself uses, rather than reimplementing the
/// formula and risking the two drifting apart.
pub fn split_reward(reward: i128, fee_bps: u32) -> Result<(i128, i128), KeeperError> {
    let fee = reward
        .checked_mul(fee_bps as i128)
        .ok_or(KeeperError::ArithmeticOverflow)?
        / 10_000; // Divisor is a non-zero literal, cannot fail
    let net = reward
        .checked_sub(fee)
        .ok_or(KeeperError::ArithmeticOverflow)?;
    Ok((net, fee))
}

/// Adds `amount` to a keeper's withdrawable balance in Persistent storage.
/// Shared by `execute_task` (credit) and used as the source of truth for
/// `withdraw_rewards`. Kept as a single helper so the CEI invariant lives in
/// one place.
///
/// TTL is renewed here (on credit) and in `withdraw_rewards` (on
/// zero-out/write), but deliberately *not* on `keeper_balance` reads — see
/// the doc comment there for why a keeper that never returns can still see
/// its balance entry archive.
pub(crate) fn credit_keeper(e: &Env, keeper: &Address, amount: i128) -> Result<(), KeeperError> {
    let key = DataKey::KeeperReward(keeper.clone());
    let current: i128 = e.storage().persistent().get(&key).unwrap_or(0);
    let updated = current
        .checked_add(amount)
        .ok_or(KeeperError::ArithmeticOverflow)?;
    e.storage().persistent().set(&key, &updated);
    e.storage().persistent().extend_ttl(
        &key,
        KEEPER_BALANCE_BUMP_THRESHOLD,
        KEEPER_BALANCE_BUMP_LEDGERS,
    );
    Ok(())
}

/// Adds `amount` to the swept-able protocol fee accumulator (instance storage).
pub(crate) fn accrue_fee(e: &Env, amount: i128) -> Result<(), KeeperError> {
    if amount == 0 {
        return Ok(());
    }
    let current: i128 = e
        .storage()
        .instance()
        .get(&DataKey::FeesAccrued)
        .unwrap_or(0);
    let updated = current
        .checked_add(amount)
        .ok_or(KeeperError::ArithmeticOverflow)?;
    e.storage().instance().set(&DataKey::FeesAccrued, &updated);
    Ok(())
}

/// Per-task parameter validation shared by `register_task` and every entry of
/// `batch_register_tasks`, so the two paths can never drift into accepting
/// different task shapes.
///
/// `min_reward` is passed in rather than read here: a batch validates N
/// entries against the same floor, and re-reading instance storage per entry
/// would charge the caller N times for one unchanging value.
pub(crate) fn validate_task_params(
    e: &Env,
    reward: i128,
    min_reward: i128,
    deadline: u64,
    calldata_len: u32,
    ttl_ledgers: u32,
    lock_ledgers: u32,
) -> Result<(), KeeperError> {
    if reward <= 0 || reward < min_reward {
        return Err(KeeperError::InvalidReward);
    }
    if deadline <= e.ledger().timestamp() {
        return Err(KeeperError::DeadlinePassed);
    }
    if calldata_len > MAX_CALLDATA_LEN {
        return Err(KeeperError::CalldataTooLarge);
    }
    if !(MIN_LOCK_LEDGERS..=MAX_LOCK_LEDGERS).contains(&lock_ledgers) {
        return Err(KeeperError::InvalidTaskParams);
    }
    if ttl_ledgers < MIN_TTL_LEDGERS {
        return Err(KeeperError::InvalidTaskParams);
    }
    if (ttl_ledgers as u64) < required_ttl_ledgers(e, deadline) {
        return Err(KeeperError::TtlTooShort);
    }
    Ok(())
}

/// Reads the configured anti-dust reward floor (0 if never set).
pub(crate) fn min_reward_floor(e: &Env) -> i128 {
    e.storage().instance().get(&DataKey::MinReward).unwrap_or(0)
}

/// True once a claimed task's exclusive lock window has elapsed, meaning any
/// keeper may re-claim it. This is what prevents a keeper from claiming and then
/// never executing: after `lock_ledgers`, the task is fair game again.
///
/// The boundary is inclusive: at `claim_ledger + lock_ledgers` exactly, the
/// lock is already considered expired (`>=`, not `>`), so a re-claim is
/// allowed in the same ledger the window ends.
pub(crate) fn lock_expired(e: &Env, task: &Task) -> bool {
    match task.claim_ledger {
        Some(claimed_at) => {
            let unlock_at = claimed_at.saturating_add(task.lock_ledgers);
            e.ledger().sequence() >= unlock_at
        }
        // Unreachable in practice: every path that sets `status = Claimed`
        // (only `claim_task`) sets `claim_ledger` in the same write, so a
        // `Claimed` task always has `Some(claim_ledger)`. Both callers of
        // `lock_expired` only reach this branch after already matching on
        // `TaskStatus::Claimed`. Treated as "no active lock" if it ever were
        // reached, which is the safe default.
        None => true,
    }
}
