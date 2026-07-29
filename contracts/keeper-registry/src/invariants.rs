//! Shared invariant assertions for the `KeeperRegistry` contract.
//!
//! One function per money invariant named in `docs/ARCHITECTURE.md`'s
//! `I-1`..`I-7` list. Both the `proptest`-based property tests in
//! `test.rs` and the fuzz targets under `fuzz/fuzz_targets/` call these
//! functions rather than each maintaining their own copy of the same
//! assertion logic, so the two suites cannot drift apart on what a given
//! invariant actually means.
//!
//! Every function returns `Result<(), String>` with a descriptive message
//! instead of panicking directly, so a caller can choose to `panic!`,
//! `assert!`, or accumulate multiple failures before reporting (useful in
//! a fuzz target, where you may want to keep going after the first
//! violation to see if there's a second, independent bug in the same
//! input).
//!
//! The contract has no "list all task ids" or "list all keepers" view (by
//! design — Soroban has no on-chain iteration over a dynamic key set), so
//! every function here takes the set of ids/addresses the *caller* has
//! already seen (e.g. every id returned by `register_task` so far in this
//! run) rather than trying to enumerate storage itself.

#![cfg(any(test, fuzzing))]

// The crate root is `#![no_std]` for the on-chain WASM build, but this
// module only ever compiles under `test`/`fuzzing`, where `std` is always
// linked anyway (the test harness and cargo-fuzz both require it) — so
// pull it in here rather than reaching for `alloc` + a global allocator
// this crate doesn't otherwise configure.
extern crate std;
use std::{format, string::String};

use soroban_sdk::{Address, Env};

use crate::{KeeperRegistryClient, TaskStatus};

/// I-1 — Solvency: the registry's token balance always equals open task
/// escrow plus credited keeper balances plus accrued fees.
///
/// `token_balance` is the reward token's `balance()` for the registry's own
/// contract address, read by the caller via a `token::Client` (this module
/// doesn't hardcode a token client since the token address is
/// contract-specific test/fuzz setup, not part of the registry ABI).
pub fn assert_solvent(
    env: &Env,
    registry: &KeeperRegistryClient,
    known_task_ids: &[u64],
    known_keepers: &[Address],
    token_balance: i128,
) -> Result<(), String> {
    let mut open_escrow: i128 = 0;
    for &task_id in known_task_ids {
        if let Ok(task) = registry.try_get_task(&task_id) {
            let task = task.map_err(|_| format!("get_task({task_id}) returned a host error"))?;
            if matches!(task.status, TaskStatus::Pending | TaskStatus::Claimed) {
                open_escrow = open_escrow
                    .checked_add(task.reward)
                    .ok_or("open_escrow overflowed while summing task rewards")?;
            }
        }
    }

    let mut keeper_balances: i128 = 0;
    for keeper in known_keepers {
        keeper_balances = keeper_balances
            .checked_add(registry.keeper_balance(keeper))
            .ok_or("keeper_balances overflowed while summing balances")?;
    }

    let fees_accrued = registry.fees_accrued();

    let owed = open_escrow
        .checked_add(keeper_balances)
        .and_then(|sum| sum.checked_add(fees_accrued))
        .ok_or("owed total overflowed (open_escrow + keeper_balances + fees_accrued)")?;

    if token_balance != owed {
        return Err(format!(
            "I-1 solvency violated: token_balance={token_balance} but owed={owed} \
             (open_escrow={open_escrow}, keeper_balances={keeper_balances}, fees_accrued={fees_accrued})"
        ));
    }

    let _ = env;
    Ok(())
}

/// I-2 — Escrow recoverability: a task in a given status has (or has
/// already used) at least one reachable path back to a resolved state.
///
/// This is fundamentally a property over a *sequence* of calls ("this task
/// eventually reaches a terminal, fund-resolved status"), not a single
/// snapshot check, so this function checks the one concrete case that's
/// checkable without driving an entire sequence: a task that is `Claimed`
/// and past its deadline must be expirable *right now*, per the
/// permissionless-expiry design in `docs/ARCHITECTURE.md`.
///
/// **This function calls `expire_task` and so mutates contract state on
/// the `Ok(())` path** — it is not a read-only check. Call it only when
/// the property test actually wants to drive this transition (e.g. as the
/// "eventually expire the abandoned task" step of a sequence), not as an
/// incidental assertion sprinkled between unrelated calls.
pub fn assert_lapsed_claim_is_expirable(
    registry: &KeeperRegistryClient,
    task_id: u64,
    now: u64,
) -> Result<(), String> {
    let task = registry
        .try_get_task(&task_id)
        .map_err(|_| format!("get_task({task_id}) host-errored"))?
        .map_err(|e| format!("get_task({task_id}) returned KeeperError: {e:?}"))?;

    if task.status != TaskStatus::Claimed {
        return Err(format!(
            "assert_lapsed_claim_is_expirable called on task {task_id} in status \
             {:?}, expected Claimed",
            task.status
        ));
    }
    if task.deadline > now {
        return Err(format!(
            "assert_lapsed_claim_is_expirable called on task {task_id} before its \
             deadline ({} > now {now}) — not yet eligible for permissionless expiry",
            task.deadline
        ));
    }

    match registry.try_expire_task(&task_id) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!(
            "I-2 escrow recoverability violated: task {task_id} is Claimed past its \
             deadline but expire_task rejected it with KeeperError: {e:?}"
        )),
        Err(_) => Err(format!(
            "I-2 escrow recoverability violated: task {task_id} is Claimed past its \
             deadline but expire_task host-errored"
        )),
    }
}

/// I-3 — Single payout: a task's reward is credited to a keeper (or
/// refunded to its owner) at most once. Checked by comparing a
/// caller-supplied "before" and "after" snapshot of the relevant balance
/// around exactly one settling call (`execute_task`, `cancel_task`, or
/// `expire_task`).
pub fn assert_single_payout(
    balance_before: i128,
    balance_after: i128,
    expected_payout: i128,
) -> Result<(), String> {
    let actual_payout = balance_after
        .checked_sub(balance_before)
        .ok_or("balance_after - balance_before overflowed")?;

    if actual_payout != expected_payout {
        return Err(format!(
            "I-3 single payout violated: expected balance to change by {expected_payout}, \
             changed by {actual_payout} instead (before={balance_before}, after={balance_after})"
        ));
    }

    Ok(())
}

/// I-4 — Fee bounding: the protocol never takes more than `fee_bps` of a
/// reward (it may take marginally less, due to floor division), and
/// `keeper_net + fee == reward` exactly (no value created or destroyed).
pub fn assert_fee_bounded(
    reward: i128,
    fee_bps: u32,
    keeper_net: i128,
    fee: i128,
) -> Result<(), String> {
    if keeper_net
        .checked_add(fee)
        .ok_or("keeper_net + fee overflowed")?
        != reward
    {
        return Err(format!(
            "I-4 fee bounding violated: keeper_net ({keeper_net}) + fee ({fee}) != reward ({reward})"
        ));
    }

    if fee < 0 || keeper_net < 0 {
        return Err(format!(
            "I-4 fee bounding violated: negative share (keeper_net={keeper_net}, fee={fee})"
        ));
    }

    // Floor division means the actual fee must be <= the nominal rate's
    // fee, never more (reward * fee_bps / 10_000, floored).
    let nominal_fee = reward
        .checked_mul(fee_bps as i128)
        .ok_or("reward * fee_bps overflowed")?
        / 10_000;

    if fee > nominal_fee {
        return Err(format!(
            "I-4 fee bounding violated: fee ({fee}) exceeds the nominal bps-derived fee ({nominal_fee}) \
             for reward={reward} fee_bps={fee_bps}"
        ));
    }

    Ok(())
}

/// I-5 — Escrow isolation: an admin action (`sweep_fees`, `set_fee_bps`,
/// `set_min_reward`, `pause`, `unpause`, `transfer_admin`, `upgrade`) must
/// never change any task's escrow or any keeper's credited balance.
/// Callers snapshot the relevant balances before and after the admin call
/// and pass both snapshots here.
pub fn assert_admin_action_isolated(
    task_rewards_before: &[(u64, i128)],
    task_rewards_after: &[(u64, i128)],
    keeper_balances_before: &[(Address, i128)],
    keeper_balances_after: &[(Address, i128)],
) -> Result<(), String> {
    if task_rewards_before != task_rewards_after {
        return Err(format!(
            "I-5 escrow isolation violated: task rewards changed across an admin action \
             (before={task_rewards_before:?}, after={task_rewards_after:?})"
        ));
    }

    if keeper_balances_before != keeper_balances_after {
        return Err(format!(
            "I-5 escrow isolation violated: keeper balances changed across an admin action \
             (before={keeper_balances_before:?}, after={keeper_balances_after:?})"
        ));
    }

    Ok(())
}

/// I-6 — Withdrawal liveness: a keeper with a positive credited balance can
/// always call `withdraw_rewards` successfully, including while the
/// contract is paused.
pub fn assert_withdrawal_live(
    registry: &KeeperRegistryClient,
    keeper: &Address,
) -> Result<(), String> {
    let balance_before = registry.keeper_balance(keeper);
    if balance_before <= 0 {
        // Nothing to withdraw is not a liveness violation.
        return Ok(());
    }

    let withdrawn = registry
        .try_withdraw_rewards(keeper)
        .map_err(|_| format!("withdraw_rewards({keeper:?}) host-errored while paused or not"))?
        .map_err(|e| format!("withdraw_rewards({keeper:?}) returned KeeperError: {e:?}"))?;

    if withdrawn != balance_before {
        return Err(format!(
            "I-6 withdrawal liveness violated: withdrew {withdrawn}, expected the full \
             pre-withdrawal balance {balance_before}"
        ));
    }

    let balance_after = registry.keeper_balance(keeper);
    if balance_after != 0 {
        return Err(format!(
            "I-6 withdrawal liveness violated: balance after full withdrawal is \
             {balance_after}, expected 0"
        ));
    }

    Ok(())
}

/// I-7 — Monotonic task ids: ids are strictly increasing and never reused.
/// Callers accumulate every id `register_task` has returned so far in a run
/// and pass the full sequence here after each new registration.
pub fn assert_task_ids_monotonic(seen_ids_in_registration_order: &[u64]) -> Result<(), String> {
    for window in seen_ids_in_registration_order.windows(2) {
        let [prev, next] = window else { continue };
        if next <= prev {
            return Err(format!(
                "I-7 monotonic task ids violated: id {next} was registered after id {prev} \
                 but is not strictly greater"
            ));
        }
    }

    let mut sorted = seen_ids_in_registration_order.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.len() != seen_ids_in_registration_order.len() {
        return Err(format!(
            "I-7 monotonic task ids violated: duplicate id found in {seen_ids_in_registration_order:?}"
        ));
    }

    Ok(())
}
