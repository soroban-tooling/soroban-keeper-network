//! Arithmetic-overflow guards and event emission.

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, TryIntoVal,
};

use super::common::*;
use crate::{split_reward, KeeperError, KeeperRegistry, KeeperRegistryClient};

// ─────────────────────────────────────────────────────────────────────────────
// Issue #15: ArithmeticOverflow tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_split_reward_extreme_value_returns_overflow_error() {
    // Any reward above i128::MAX / 10_000 will overflow the multiplication
    // when fee_bps is at the max (10_000). This test pins that the function returns a
    // typed error rather than panicking.
    let extreme_reward = i128::MAX / 9_999; // Will overflow when multiplied by 10_000
    let fee_bps = 10_000u32; // Max fee rate

    let result = split_reward(extreme_reward, fee_bps);
    assert_eq!(result, Err(KeeperError::ArithmeticOverflow));
}

#[test]
fn test_split_reward_max_safe_value_succeeds() {
    // The largest reward that can be safely multiplied by 10_000
    let safe_reward = i128::MAX / 10_000;
    let fee_bps = 300u32;

    let result = split_reward(safe_reward, fee_bps);
    assert!(result.is_ok());
    let (keeper_net, fee) = result.unwrap();
    assert_eq!(keeper_net + fee, safe_reward);
}

#[test]
fn test_split_reward_with_zero_fee_never_overflows() {
    // With fee_bps = 0, the multiplication by 0 can never overflow
    let huge_reward = i128::MAX;
    let result = split_reward(huge_reward, 0);
    assert!(result.is_ok());
    let (keeper_net, fee) = result.unwrap();
    assert_eq!(keeper_net, huge_reward);
    assert_eq!(fee, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #16: set_min_reward event emission tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_min_reward_emits_event() {
    let s = setup();
    let old_min = s.registry.min_reward(); // initially 0
    let new_min = 500_000i128;
    s.registry.set_min_reward(&s.admin, &new_min);
    // Find the minrwd event - it should be emitted
    let events = s.env.events().all();
    let mut found = false;
    for event in events.iter() {
        let data_result: Result<(i128, i128), _> = event.2.try_into_val(&s.env);
        if let Ok((event_old, event_new)) = data_result {
            if event_old == old_min && event_new == new_min {
                found = true;
                break;
            }
        }
    }
    assert!(found, "MinRewardUpdated event was not emitted");
}

#[test]
fn test_set_min_reward_no_event_when_validation_fails() {
    let s = setup();
    let events_before = s.env.events().all();
    // Negative reward fails validation
    let _ = s.registry.try_set_min_reward(&s.admin, &-1i128);
    let events_after = s.env.events().all();
    // No new min reward event should be added
    let mut found_new_min_reward_event = false;
    for i in events_before.len()..events_after.len() {
        let event = events_after.get(i).unwrap();
        // Try to parse as min reward event
        let data_result: Result<(i128, i128), _> = event.2.try_into_val(&s.env);
        if data_result.is_ok() {
            found_new_min_reward_event = true;
        }
    }
    assert!(
        !found_new_min_reward_event,
        "no event should be emitted on validation failure"
    );
}

#[test]
fn test_set_min_reward_event_captures_old_and_new() {
    let s = setup();
    // Set initial value
    s.registry.set_min_reward(&s.admin, &100_000i128);
    // Change it again
    s.registry.set_min_reward(&s.admin, &200_000i128);
    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (i128, i128) = event.2.try_into_val(&s.env).unwrap();
    let (event_old, event_new) = data;
    assert_eq!(event_old, 100_000i128);
    assert_eq!(event_new, 200_000i128);
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #17: sweep_fees event emission tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_fees_emits_event() {
    let s = setup();
    let _ = executed_task_keeper(&s); // accrues 30_000 fee
    let treasury = Address::generate(&s.env);
    s.registry.sweep_fees(&s.admin, &treasury, &30_000i128);
    // Verify event data - last event should be the sweep
    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (Address, i128, i128) = event.2.try_into_val(&s.env).unwrap();
    let (event_treasury, event_amount, event_remaining) = data;
    assert_eq!(event_treasury, treasury);
    assert_eq!(event_amount, 30_000i128);
    assert_eq!(event_remaining, 0i128);
}

#[test]
fn test_sweep_fees_partial_amount_shows_remaining() {
    let s = setup();
    let _ = executed_task_keeper(&s); // accrues 30_000 fee
    let treasury = Address::generate(&s.env);
    s.registry.sweep_fees(&s.admin, &treasury, &12_000i128);
    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (Address, i128, i128) = event.2.try_into_val(&s.env).unwrap();
    let (_event_treasury, event_amount, event_remaining) = data;
    assert_eq!(event_amount, 12_000i128);
    assert_eq!(event_remaining, 18_000i128);
    // Verify remaining matches actual state
    assert_eq!(s.registry.fees_accrued(), 18_000i128);
}

#[test]
fn test_sweep_fees_no_event_when_validation_fails() {
    let s = setup();
    let _ = executed_task_keeper(&s); // accrues 30_000
    let treasury = Address::generate(&s.env);
    let events_before = s.env.events().all();
    // Try to sweep more than accrued
    let _ = s.registry.try_sweep_fees(&s.admin, &treasury, &30_001i128);
    let events_after = s.env.events().all();
    // Check that no sweep event was added (events may include diagnostic events)
    // The sweep event has 3 fields: (Address, i128, i128)
    let mut found_sweep_event = false;
    for i in events_before.len()..events_after.len() {
        let event = events_after.get(i).unwrap();
        let data_result: Result<(Address, i128, i128), _> = event.2.try_into_val(&s.env);
        if data_result.is_ok() {
            found_sweep_event = true;
        }
    }
    assert!(
        !found_sweep_event,
        "no sweep event should be emitted on validation failure"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #19: initialize event emission tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);
    // Verify event data - last event should be the init event
    let events = env.events().all();
    let event = events.last().unwrap();
    // Data contains (admin, reward_token, fee_bps)
    let data: (Address, Address, u32) = event.2.try_into_val(&env).unwrap();
    let (event_admin, event_token, event_fee_bps) = data;
    assert_eq!(event_admin, admin);
    assert_eq!(event_token, token_id);
    assert_eq!(event_fee_bps, 300u32);
}

#[test]
fn test_initialize_no_event_on_second_call() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);
    let events_before = env.events().all();
    // Second initialize call fails
    let _ = registry.try_initialize(&admin, &token_id, &300u32);
    let events_after = env.events().all();
    // Check that no init event was added
    let mut found_init_event = false;
    for i in events_before.len()..events_after.len() {
        let event = events_after.get(i).unwrap();
        let data_result: Result<(Address, Address, u32), _> = event.2.try_into_val(&env);
        if data_result.is_ok() {
            found_init_event = true;
        }
    }
    assert!(
        !found_init_event,
        "no event should be emitted on rejected second initialize"
    );
}

#[test]
fn test_initialize_no_event_when_validation_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let events_before = env.events().all();

    // Invalid fee_bps > 10_000
    let _ = registry.try_initialize(&admin, &token_id, &10_001u32);

    let events_after = env.events().all();
    // Check that no init event was added
    let mut found_init_event = false;
    for i in events_before.len()..events_after.len() {
        let event = events_after.get(i).unwrap();
        let data_result: Result<(Address, Address, u32), _> = event.2.try_into_val(&env);
        if data_result.is_ok() {
            found_init_event = true;
        }
    }
    assert!(
        !found_init_event,
        "no event should be emitted on validation failure"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #118: Verifier event emission tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_emit_verifier_attached_event() {
    let s = setup();
    let verifier = Address::generate(&s.env);
    let task_id = 42u64;

    crate::emit_verifier_attached(&s.env, task_id, &verifier);

    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (u64, Address) = event.2.try_into_val(&s.env).unwrap();
    assert_eq!(data.0, task_id);
    assert_eq!(data.1, verifier);
}

#[test]
fn test_emit_verifier_updated_event_before_after_pattern() {
    let s = setup();
    let old_verifier = Address::generate(&s.env);
    let new_verifier = Address::generate(&s.env);
    let task_id = 100u64;

    // Test update from Some to Some
    crate::emit_verifier_updated(
        &s.env,
        task_id,
        Some(old_verifier.clone()),
        Some(new_verifier.clone()),
    );
    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (u64, Option<Address>, Option<Address>) = event.2.try_into_val(&s.env).unwrap();
    assert_eq!(data.0, task_id);
    assert_eq!(data.1, Some(old_verifier));
    assert_eq!(data.2, Some(new_verifier));

    // Test update clearing verifier (Some to None)
    crate::emit_verifier_updated(&s.env, task_id, Some(old_verifier.clone()), None);
    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (u64, Option<Address>, Option<Address>) = event.2.try_into_val(&s.env).unwrap();
    assert_eq!(data.0, task_id);
    assert_eq!(data.1, Some(old_verifier));
    assert_eq!(data.2, None);

    // Test attaching verifier to previously unverified task (None to Some)
    crate::emit_verifier_updated(&s.env, task_id, None, Some(new_verifier.clone()));
    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (u64, Option<Address>, Option<Address>) = event.2.try_into_val(&s.env).unwrap();
    assert_eq!(data.0, task_id);
    assert_eq!(data.1, None);
    assert_eq!(data.2, Some(new_verifier));
}

#[test]
fn test_emit_task_verification_failed_event() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let task_id = 7u64;

    crate::emit_task_verification_failed(&s.env, task_id, &keeper);

    let events = s.env.events().all();
    let event = events.last().unwrap();
    let data: (u64, Address) = event.2.try_into_val(&s.env).unwrap();
    assert_eq!(data.0, task_id);
    assert_eq!(data.1, keeper);
}
