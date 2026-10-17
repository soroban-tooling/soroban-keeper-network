//! Task-condition registration and claim gating.

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    Address, Bytes, Env,
};

use super::common::*;
use crate::{KeeperError, TaskStatus, TaskType};

#[contract]
struct TestCondition;

#[contractimpl]
impl TestCondition {
    pub fn set(env: Env, value: u32) {
        env.storage().instance().set(&0u32, &value);
    }

    pub fn is_met(env: Env, _task_id: u64) -> bool {
        match env.storage().instance().get(&0u32).unwrap_or(0u32) {
            0 => false,
            1 => true,
            _ => panic!("condition failure"),
        }
    }
}

fn register_with_condition(s: &TestSetup, condition: Address) -> u64 {
    let deadline = s.env.ledger().timestamp() + 3_600;
    s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &120,
        &None,
        &Some(condition),
    )
}

#[test]
fn true_condition_allows_claim_and_is_claimable_agrees() {
    let s = setup();
    let condition = s.env.register(TestCondition, ());
    TestConditionClient::new(&s.env, &condition).set(&1);
    let keeper = Address::generate(&s.env);
    let id = register_with_condition(&s, condition.clone());

    assert_eq!(s.registry.get_task(&id).condition, Some(condition));
    assert!(s.registry.is_claimable(&id));
    s.registry.claim_task(&keeper, &id);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
}

#[test]
fn false_condition_rejects_without_mutating_task() {
    let s = setup();
    let condition = s.env.register(TestCondition, ());
    TestConditionClient::new(&s.env, &condition).set(&0);
    let keeper = Address::generate(&s.env);
    let id = register_with_condition(&s, condition.clone());

    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::ConditionNotMet))
    );
    let task = s.registry.get_task(&id);
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.claimer, None);
    assert_eq!(task.condition, Some(condition));
}

#[test]
fn missing_condition_contract_fails_closed() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_with_condition(&s, Address::generate(&s.env));

    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::ConditionNotMet))
    );
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Pending);
}

#[test]
fn panicking_condition_is_isolated_and_fails_closed() {
    let s = setup();
    let condition = s.env.register(TestCondition, ());
    TestConditionClient::new(&s.env, &condition).set(&2);
    let keeper = Address::generate(&s.env);
    let id = register_with_condition(&s, condition);

    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::ConditionNotMet))
    );
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Pending);
}

#[test]
fn is_claimable_and_claim_task_share_condition_and_state_guards() {
    // Pending + true: both paths allow the claim.
    let s = setup();
    let condition = s.env.register(TestCondition, ());
    let condition_client = TestConditionClient::new(&s.env, &condition);
    condition_client.set(&1);
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let id = register_with_condition(&s, condition.clone());
    assert!(s.registry.is_claimable(&id));
    s.registry.claim_task(&first, &id);

    // Claimed + active lock: task state wins regardless of condition value.
    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
    condition_client.set(&0);
    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );

    // Claimed + expired lock + false condition: both paths reject the claim.
    let unlock_at = s.registry.get_task(&id).claim_ledger.unwrap() + 120;
    s.env.ledger().set_sequence_number(unlock_at);
    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::ConditionNotMet))
    );

    // Flipping the same condition makes the same expired-lock task claimable.
    condition_client.set(&1);
    assert!(s.registry.is_claimable(&id));
    s.registry.claim_task(&second, &id);

    // A terminal task remains unclaimable even if its condition is true.
    s.registry
        .execute_task(&second, &id, &Bytes::from_slice(&s.env, b"proof"));
    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&first, &id),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}
