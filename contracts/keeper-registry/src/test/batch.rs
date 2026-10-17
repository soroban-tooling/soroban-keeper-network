//! `batch_register_tasks`.

// This module only compiles under cfg(test), where std is always linked.
extern crate std;

use soroban_sdk::{testutils::Address as _, token, Address, Bytes, Env, Vec};

use super::common::*;
use crate::{
    split_reward, BatchTaskParams, KeeperError, TaskStatus, TaskType, MAX_BATCH_SIZE,
    MAX_CALLDATA_LEN, MAX_LOCK_LEDGERS, MIN_LOCK_LEDGERS, MIN_TTL_LEDGERS,
};

// ─────────────────────────────────────────────────────────────────────────────
// batch_register_tasks
//
// Semantics under test mirror docs/BATCH_OPERATIONS.md: one auth for the whole
// batch (§2), whole-batch atomicity with zero partial success (§3), a
// MAX_BATCH_SIZE ceiling (§4), ids returned in input order (§5), and the
// max_total_reward ceiling (§7).
// ─────────────────────────────────────────────────────────────────────────────

/// One well-formed batch entry with a caller-chosen reward.
fn batch_entry(env: &Env, reward: i128) -> BatchTaskParams {
    BatchTaskParams {
        task_type: TaskType::Liquidation,
        calldata: calldata(env),
        reward,
        deadline: env.ledger().timestamp() + 3_600,
        ttl_ledgers: DEFAULT_TTL_LEDGERS,
        lock_ledgers: 120,
        condition: None,
    }
}

/// A batch of `n` entries, each worth `reward`.
fn batch_of(env: &Env, n: u32, reward: i128) -> Vec<BatchTaskParams> {
    let mut v = Vec::new(env);
    for _ in 0..n {
        v.push_back(batch_entry(env, reward));
    }
    v
}

#[test]
fn test_batch_register_registers_all_and_returns_ids_in_order() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);

    let tasks = batch_of(&s.env, 3, 1_000_000i128);
    let ids = s
        .registry
        .batch_register_tasks(&s.admin, &tasks, &3_000_000i128);

    assert_eq!(ids.len(), 3);
    // Ids are the contract's own monotonic sequence, in input order.
    assert_eq!(ids.get(1).unwrap(), ids.get(0).unwrap() + 1);
    assert_eq!(ids.get(2).unwrap(), ids.get(1).unwrap() + 1);

    for id in ids.iter() {
        let task = s.registry.get_task(&id);
        assert_eq!(task.owner, s.admin);
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.reward, 1_000_000i128);
    }

    // Escrow for the whole batch is held by the registry.
    assert_eq!(token.balance(&s.registry.address), 3_000_000i128);
    assert_eq!(s.registry.task_count(), 3);
}

#[test]
fn test_batch_register_persists_mixed_conditions() {
    let s = setup();
    let first_condition = Address::generate(&s.env);
    let second_condition = Address::generate(&s.env);

    let mut tasks = Vec::new(&s.env);
    tasks.push_back(BatchTaskParams {
        condition: Some(first_condition.clone()),
        ..batch_entry(&s.env, 1_000_000)
    });
    tasks.push_back(batch_entry(&s.env, 1_000_000));
    tasks.push_back(BatchTaskParams {
        condition: Some(second_condition.clone()),
        ..batch_entry(&s.env, 1_000_000)
    });

    let ids = s
        .registry
        .batch_register_tasks(&s.admin, &tasks, &3_000_000);

    assert_eq!(
        s.registry.get_task(&ids.get(0).unwrap()).condition,
        Some(first_condition)
    );
    assert_eq!(s.registry.get_task(&ids.get(1).unwrap()).condition, None);
    assert_eq!(
        s.registry.get_task(&ids.get(2).unwrap()).condition,
        Some(second_condition)
    );
}

#[test]
fn test_batch_register_max_total_reward_ceiling_rejects_whole_batch() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);

    // Sum is 3_000_000; the ceiling is one stroop short of it.
    let tasks = batch_of(&s.env, 3, 1_000_000i128);
    assert_eq!(
        s.registry
            .try_batch_register_tasks(&s.admin, &tasks, &2_999_999i128),
        Err(Ok(KeeperError::BatchRewardCeilingExceeded))
    );

    // §3: zero transfers, zero tasks — not "the first two landed".
    assert_eq!(token.balance(&s.registry.address), 0i128);
    assert_eq!(s.registry.task_count(), 0);
}

#[test]
fn test_batch_register_accepts_ceiling_set_to_exact_sum() {
    let s = setup();
    // The guidance in docs §7 is to set max_total_reward to the exact sum, so
    // the boundary itself must not be off-by-one.
    let tasks = batch_of(&s.env, 2, 1_000_000i128);
    let ids = s
        .registry
        .batch_register_tasks(&s.admin, &tasks, &2_000_000i128);
    assert_eq!(ids.len(), 2);
}

#[test]
fn test_batch_register_rejects_batch_over_max_size() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);

    let tasks = batch_of(&s.env, MAX_BATCH_SIZE + 1, 1i128);
    assert_eq!(
        s.registry
            .try_batch_register_tasks(&s.admin, &tasks, &i128::MAX),
        Err(Ok(KeeperError::BatchTooLarge))
    );
    assert_eq!(token.balance(&s.registry.address), 0i128);
    assert_eq!(s.registry.task_count(), 0);
}

#[test]
fn test_batch_register_accepts_exactly_max_batch_size() {
    let s = setup();
    let tasks = batch_of(&s.env, MAX_BATCH_SIZE, 1i128);
    let ids = s
        .registry
        .batch_register_tasks(&s.admin, &tasks, &(MAX_BATCH_SIZE as i128));
    assert_eq!(ids.len(), MAX_BATCH_SIZE);
}

#[test]
fn test_batch_register_max_batch_size_view_matches_constant() {
    let s = setup();
    assert_eq!(s.registry.max_batch_size(), MAX_BATCH_SIZE);
}

#[test]
fn test_batch_register_rejects_empty_batch() {
    let s = setup();
    let tasks: Vec<BatchTaskParams> = Vec::new(&s.env);
    assert_eq!(
        s.registry
            .try_batch_register_tasks(&s.admin, &tasks, &1_000_000i128),
        Err(Ok(KeeperError::EmptyBatch))
    );
}

#[test]
fn test_batch_register_rejects_non_positive_ceiling() {
    let s = setup();
    let tasks = batch_of(&s.env, 1, 1_000_000i128);
    assert_eq!(
        s.registry
            .try_batch_register_tasks(&s.admin, &tasks, &0i128),
        Err(Ok(KeeperError::InvalidReward))
    );
}

/// A single bad entry rejects the batch and rolls back the good entries with
/// it — the "no partial success" guarantee integrators are told to rely on.
#[test]
fn test_batch_register_one_bad_entry_rejects_entire_batch() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);

    let cases: std::vec::Vec<(BatchTaskParams, KeeperError)> = std::vec![
        (
            BatchTaskParams {
                reward: 0,
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::InvalidReward,
        ),
        (
            BatchTaskParams {
                deadline: s.env.ledger().timestamp(),
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::DeadlinePassed,
        ),
        (
            BatchTaskParams {
                calldata: Bytes::from_slice(&s.env, &[0u8; (MAX_CALLDATA_LEN + 1) as usize]),
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::CalldataTooLarge,
        ),
        (
            BatchTaskParams {
                lock_ledgers: MIN_LOCK_LEDGERS - 1,
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::InvalidTaskParams,
        ),
        (
            BatchTaskParams {
                lock_ledgers: MAX_LOCK_LEDGERS + 1,
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::InvalidTaskParams,
        ),
        (
            BatchTaskParams {
                ttl_ledgers: MIN_TTL_LEDGERS - 1,
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::InvalidTaskParams,
        ),
        (
            BatchTaskParams {
                // Issue 11 fix for batch parameters too: ttl must cover deadline
                ttl_ledgers: 17_280, // far too short for this deadline
                deadline: s.env.ledger().timestamp() + 2_592_000,
                ..batch_entry(&s.env, 1_000_000i128)
            },
            KeeperError::TtlTooShort,
        ),
    ];

    for (bad, expected) in cases {
        // Good entry first, so a rejection proves the whole batch rolled back
        // rather than stopping before it had done anything.
        let mut tasks = Vec::new(&s.env);
        tasks.push_back(batch_entry(&s.env, 1_000_000i128));
        tasks.push_back(bad);

        assert_eq!(
            s.registry
                .try_batch_register_tasks(&s.admin, &tasks, &i128::MAX),
            Err(Ok(expected)),
        );
        assert_eq!(token.balance(&s.registry.address), 0i128);
        assert_eq!(s.registry.task_count(), 0);
    }
}

#[test]
fn test_batch_register_respects_min_reward_floor() {
    let s = setup();
    s.registry.set_min_reward(&s.admin, &500_000i128);

    let mut tasks = Vec::new(&s.env);
    tasks.push_back(batch_entry(&s.env, 500_000i128)); // exactly at the floor
    tasks.push_back(batch_entry(&s.env, 499_999i128)); // one below

    assert_eq!(
        s.registry
            .try_batch_register_tasks(&s.admin, &tasks, &i128::MAX),
        Err(Ok(KeeperError::InvalidReward))
    );
    assert_eq!(s.registry.task_count(), 0);
}

#[test]
fn test_batch_register_blocked_while_paused() {
    let s = setup();
    s.registry.pause(&s.admin);

    let tasks = batch_of(&s.env, 2, 1_000_000i128);
    assert_eq!(
        s.registry
            .try_batch_register_tasks(&s.admin, &tasks, &2_000_000i128),
        Err(Ok(KeeperError::ContractPaused))
    );
}

/// Batch-registered tasks are ordinary tasks: nothing about how they were
/// created changes claim/execute or the refund paths.
#[test]
fn test_batch_registered_task_completes_normal_lifecycle() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = Address::generate(&s.env);

    let tasks = batch_of(&s.env, 2, 1_000_000i128);
    let ids = s
        .registry
        .batch_register_tasks(&s.admin, &tasks, &2_000_000i128);
    let (executed_id, cancelled_id) = (ids.get(0).unwrap(), ids.get(1).unwrap());

    s.registry.claim_task(&keeper, &executed_id);
    s.registry
        .execute_task(&keeper, &executed_id, &Bytes::from_slice(&s.env, b"proof"));
    let (net, fee) = split_reward(1_000_000i128, 300).unwrap();
    assert_eq!(s.registry.keeper_balance(&keeper), net);
    assert_eq!(s.registry.fees_accrued(), fee);

    // Each entry's escrow is refundable independently of the rest of its batch.
    s.registry.cancel_task(&s.admin, &cancelled_id);
    assert_eq!(
        s.registry.get_task(&cancelled_id).status,
        TaskStatus::Cancelled
    );
    // Only the executed task's reward (net + fee) is still held.
    assert_eq!(token.balance(&s.registry.address), 1_000_000i128);
}

/// A batch may only pull escrow from the address that authorized it: entries
/// carry no per-entry owner, so every task in the batch is owned by the single
/// authorizing `owner` (§2) and nobody else's funds are reachable.
#[test]
fn test_batch_register_tasks_are_all_owned_by_the_authorizing_owner() {
    let s = setup();
    let other = Address::generate(&s.env);

    let tasks = batch_of(&s.env, 3, 1_000_000i128);
    let ids = s
        .registry
        .batch_register_tasks(&s.admin, &tasks, &3_000_000i128);

    for id in ids.iter() {
        assert_eq!(s.registry.get_task(&id).owner, s.admin);
    }

    // A non-owner cannot cancel any of them.
    assert_eq!(
        s.registry.try_cancel_task(&other, &ids.get(0).unwrap()),
        Err(Ok(KeeperError::NotTaskOwner))
    );
}
