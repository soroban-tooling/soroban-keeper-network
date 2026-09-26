//! Reputation bookkeeping integrated with task success and expired claim takeover.

use soroban_sdk::{testutils::Address as _, Address, Bytes};

use super::common::*;
use crate::reputation::stored_record;

fn record(s: &TestSetup, keeper: &Address) -> crate::reputation::ReputationRecord {
    s.env
        .as_contract(&s.registry.address, || stored_record(&s.env, keeper))
}

#[test]
fn successes_and_missed_lock_window_update_reputation() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let next_keeper = Address::generate(&s.env);

    for _ in 0..2 {
        let task_id = register_default_task(&s);
        s.registry.claim_task(&keeper, &task_id);
        s.registry
            .execute_task(&keeper, &task_id, &Bytes::from_slice(&s.env, b"proof"));
    }

    let missed_task = register_default_task(&s);
    s.registry.claim_task(&keeper, &missed_task);
    advance(&s.env, 120, 0);
    s.registry.claim_task(&next_keeper, &missed_task);

    let record = record(&s, &keeper);
    assert_eq!(record.successes, 2);
    assert_eq!(record.missed_claims, 1);
    assert_eq!(record.score_bps, 6_666);
    assert_eq!(record.last_updated_ledger, s.env.ledger().sequence());
}

#[test]
fn failed_or_rejected_actions_do_not_update_reputation() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let task_id = register_default_task(&s);

    s.registry.claim_task(&keeper, &task_id);
    assert_eq!(
        s.registry.try_execute_task(
            &keeper,
            &task_id,
            &Bytes::from_slice(&s.env, &[0; (crate::MAX_PROOF_LEN + 1) as usize]),
        ),
        Err(Ok(crate::KeeperError::ProofTooLarge))
    );

    let record = record(&s, &keeper);
    assert_eq!(record.successes, 0);
    assert_eq!(record.missed_claims, 0);
    assert_eq!(record.score_bps, 0);
}
