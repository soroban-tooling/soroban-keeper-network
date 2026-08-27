//! Property tests, one per money invariant, sharing `crate::invariants`.
//!
//! Intentionally a SMALL proptest per invariant, not the full-depth
//! exploration that backlog 0054-0060 calls for — those remain open,
//! separately-scoped issues. Extend these in place rather than duplicating
//! them once that work lands.

// This module only compiles under cfg(test), where std is always linked.
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Deployer as _},
    token, Address, Bytes,
};

use super::common::*;
use crate::{split_reward, KeeperError, TaskType, INSTANCE_BUMP_THRESHOLD, MIN_TTL_LEDGERS};

use crate::invariants::{
    assert_admin_action_isolated, assert_fee_bounded, assert_lapsed_claim_is_expirable,
    assert_solvent, assert_task_ids_monotonic, assert_withdrawal_live,
};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    // I-1 — Solvency, across a random handful of tasks with random rewards
    // and a mix of execute/cancel/leave-pending outcomes.
    //
    // `setup()` mints a fixed 10_000_000 units to `admin`; up to 5 tasks can
    // be generated here, so each reward is capped at 1_000_000 to guarantee
    // the sum never exceeds what's actually mintable (a proptest input that
    // can't be funded would fail for a reason unrelated to the invariant
    // under test).
    #[test]
    fn property_i1_solvency_holds_across_random_task_outcomes(
        rewards in prop::collection::vec(1_i128..1_000_000, 1..6),
        outcomes in prop::collection::vec(0u8..3, 1..6),
    ) {
        let s = setup();
        let token = token::Client::new(&s.env, &s.token_id);
        let keeper = Address::generate(&s.env);
        let mut task_ids = std::vec::Vec::new();

        for (reward, outcome) in rewards.iter().zip(outcomes.iter()) {
            let id = register_reward_task(&s, *reward);
            task_ids.push(id);
            match outcome % 3 {
                0 => {
                    // Execute.
                    s.registry.claim_task(&keeper, &id);
                    s.registry
                        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));
                }
                1 => {
                    // Cancel.
                    s.registry.cancel_task(&s.admin, &id);
                }
                _ => {
                    // Leave Pending — still open escrow.
                }
            }
        }

        let balance = token.balance(&s.registry.address);
        assert_solvent(&s.env, &s.registry, &task_ids, &[keeper], balance)
            .expect("I-1 solvency must hold after any mix of task outcomes");
    }

    // I-1 (verifier extension) — issue #119 / backlog 0094. Extends I-1
    // (docs/ARCHITECTURE.md: token.balance(&registry) == open escrow +
    // keeper balances + accrued fees) — proved above against the
    // pre-verifier contract per issue 0054 — to cover the verifier-gated
    // execute_task path added by this epic's design doc
    // (docs/VERIFIER_DESIGN.md). The property continues to hold across
    // randomized sequences that mix tasks with no verifier, an
    // always-approving verifier, and an always-rejecting verifier — the same
    // test-only verifier contracts `test/verifier.rs` uses for issues
    // #105/0083/0084, reused here per 0094's explicit instruction rather
    // than duplicated. Also generalizes 0084's assertion (a verifier
    // rejection never moves tokens) across random sequences instead of one
    // fixed scenario.
    #[test]
    fn property_i1_solvency_holds_with_verifier_attached_tasks(
        rewards in prop::collection::vec(1_i128..1_000_000, 1..6),
        verifier_modes in prop::collection::vec(0u8..3, 1..6),
    ) {
        let s = setup();
        let token = token::Client::new(&s.env, &s.token_id);
        let keeper = Address::generate(&s.env);

        let approve_id = s
            .env
            .register(super::verifier::always_approve_verifier::AlwaysApproveVerifier, ());
        let reject_id = s
            .env
            .register(super::verifier::always_reject_verifier::AlwaysRejectVerifier, ());

        let mut task_ids = std::vec::Vec::new();
        for (reward, mode) in rewards.iter().zip(verifier_modes.iter()) {
            let deadline = s.env.ledger().timestamp() + 3_600;
            let verifier = match mode % 3 {
                0 => None,
                1 => Some(approve_id.clone()),
                _ => Some(reject_id.clone()),
            };
            let id = s.registry.register_task(
                &s.admin,
                &TaskType::Liquidation,
                &calldata(&s.env),
                reward,
                &deadline,
                &DEFAULT_TTL_LEDGERS,
                &120u32,
                &verifier,
            );
            task_ids.push(id);

            s.registry.claim_task(&keeper, &id);
            let balance_before_attempt = token.balance(&s.registry.address);
            let result =
                s.registry
                    .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));

            if mode % 3 == 2 {
                // Rejecting verifier: execution must fail, and — the property
                // this extension exists to pin — no token may have moved.
                prop_assert_eq!(
                    result,
                    Err(Ok(KeeperError::VerificationFailed)),
                    "a rejecting verifier must fail execute_task with VerificationFailed"
                );
                prop_assert_eq!(
                    token.balance(&s.registry.address),
                    balance_before_attempt,
                    "a verifier rejection must never move tokens"
                );
            } else {
                // No verifier, or an approving one: execution must succeed.
                prop_assert!(
                    result.is_ok(),
                    "expected execute_task to succeed for verifier mode {}",
                    mode % 3
                );
            }
        }

        let balance = token.balance(&s.registry.address);
        assert_solvent(&s.env, &s.registry, &task_ids, &[keeper], balance).expect(
            "I-1 solvency must hold across a mix of none/approve/reject verifier outcomes",
        );
    }

    // I-2 — Escrow recoverability: a claimed task past its deadline is
    // always expirable. Issue 0005 (ttl shorter than deadline strands
    // escrow) originally required this property to carve out the
    // ttl-shorter-than-deadline case; that bug is now fixed at the
    // `register_task` boundary (see `property_i8` below), so an escrow
    // that reaches `Claimed` can never have a ttl_ledgers too short to
    // cover its own deadline, and no exemption is needed here.
    #[test]
    fn property_i2_lapsed_claim_is_always_expirable(reward in 1_i128..9_000_000) {
        let s = setup();
        let keeper = Address::generate(&s.env);
        let id = register_reward_task(&s, reward);

        s.registry.claim_task(&keeper, &id);
        // Past both the lock window and the task deadline (register_reward_task
        // sets a 1-hour deadline).
        advance(&s.env, 1000, 3_601);

        let now = s.env.ledger().timestamp();
        assert_lapsed_claim_is_expirable(&s.registry, id, now)
            .expect("I-2: a Claimed task past its deadline must be expirable");
    }

    // I-3 — Single payout: executing a task credits the keeper exactly
    // once; a second execute attempt is rejected, not double-paid.
    #[test]
    fn property_i3_single_payout_not_doubled(reward in 1_i128..9_000_000) {
        let s = setup();
        let keeper = Address::generate(&s.env);
        let id = register_reward_task(&s, reward);

        s.registry.claim_task(&keeper, &id);
        let balance_before = s.registry.keeper_balance(&keeper);
        s.registry
            .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));
        let balance_after_first = s.registry.keeper_balance(&keeper);

        let (expected_net, _fee) = split_reward(reward, s.registry.get_fee_bps()).unwrap();
        crate::invariants::assert_single_payout(balance_before, balance_after_first, expected_net)
            .expect("I-3: first execution must credit exactly the net reward once");

        // A second execute on the same (now Executed) task must be
        // rejected, and must not touch the keeper's balance again.
        let second = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p2"));
        prop_assert!(second.is_err(), "re-executing an Executed task must be rejected");
        let balance_after_second_attempt = s.registry.keeper_balance(&keeper);
        prop_assert_eq!(
            balance_after_second_attempt,
            balance_after_first,
            "a rejected re-execution must not change the keeper's balance"
        );
    }

    // I-4 — Fee bounding, across arbitrary reward/fee_bps combinations.
    #[test]
    fn property_i4_fee_bounded_across_arbitrary_inputs(
        reward in 1_i128..i128::from(u64::MAX),
        fee_bps in 0u32..=10_000u32,
    ) {
        let (keeper_net, fee) = split_reward(reward, fee_bps).unwrap();
        assert_fee_bounded(reward, fee_bps, keeper_net, fee)
            .expect("I-4 fee bounding must hold for every reward/fee_bps combination");
    }

    // I-5 — Escrow isolation: sweeping accrued fees must never change any
    // task's escrowed reward or any keeper's credited balance. Two tasks
    // are registered from the same `reward`, so it's capped at half the
    // minted supply.
    #[test]
    fn property_i5_sweep_fees_isolated_from_escrow_and_keeper_balances(
        reward in 1_i128..4_500_000,
    ) {
        let s = setup();
        let keeper = Address::generate(&s.env);
        let executed_id = register_reward_task(&s, reward);
        let pending_id = register_reward_task(&s, reward);

        s.registry.claim_task(&keeper, &executed_id);
        s.registry
            .execute_task(&keeper, &executed_id, &Bytes::from_slice(&s.env, b"p"));

        let task_rewards_before = std::vec![
            (executed_id, s.registry.get_task(&executed_id).reward),
            (pending_id, s.registry.get_task(&pending_id).reward),
        ];
        let keeper_balances_before = std::vec![(keeper.clone(), s.registry.keeper_balance(&keeper))];

        let accrued = s.registry.fees_accrued();
        if accrued > 0 {
            let treasury = Address::generate(&s.env);
            s.registry.sweep_fees(&s.admin, &treasury, &accrued);
        }

        let task_rewards_after = std::vec![
            (executed_id, s.registry.get_task(&executed_id).reward),
            (pending_id, s.registry.get_task(&pending_id).reward),
        ];
        let keeper_balances_after = std::vec![(keeper.clone(), s.registry.keeper_balance(&keeper))];

        assert_admin_action_isolated(
            &task_rewards_before,
            &task_rewards_after,
            &keeper_balances_before,
            &keeper_balances_after,
        )
        .expect("I-5: sweep_fees must never touch task escrow or keeper balances");
    }

    // I-6 — Withdrawal liveness: a keeper's credited balance is always
    // withdrawable, including while the contract is paused.
    #[test]
    fn property_i6_withdrawal_live_while_paused(reward in 1_i128..9_000_000) {
        let s = setup();
        let keeper = Address::generate(&s.env);
        let id = register_reward_task(&s, reward);

        s.registry.claim_task(&keeper, &id);
        s.registry
            .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));

        s.registry.pause(&s.admin);
        assert_withdrawal_live(&s.registry, &keeper)
            .expect("I-6: a keeper's balance must be withdrawable even while paused");
    }

    // I-7 — Monotonic task ids: registering N tasks in a row always yields
    // strictly increasing, non-repeating ids. Up to 7 tasks, so each
    // reward is capped at 1_000_000 to stay within the minted supply.
    #[test]
    fn property_i7_task_ids_strictly_increasing(
        rewards in prop::collection::vec(1_i128..1_000_000, 2..8),
    ) {
        let s = setup();
        let mut ids = std::vec::Vec::new();
        for reward in &rewards {
            ids.push(register_reward_task(&s, *reward));
        }

        assert_task_ids_monotonic(&ids)
            .expect("I-7: task ids must be strictly increasing and never reused");
    }

    // I-8 — TTL covers deadline (issue 0120, pinning issue 0005's fix):
    // register_task must reject any (deadline, ttl_ledgers) pair whose
    // persistent Task entry would expire before the task's own deadline,
    // and must do so with KeeperError::TtlTooShort specifically — never
    // silently accepting a registration that could later strand its
    // escrow. Conversely, any ttl_ledgers that does cover
    // `required_ttl_ledgers` (deadline distance plus the safety margin)
    // must be accepted.
    #[test]
    fn property_i8_ttl_always_covers_deadline_or_registration_is_rejected(
        seconds_until_deadline in 1_u64..300_000,
        ttl_ledgers in MIN_TTL_LEDGERS..120_000u32,
    ) {
        let s = setup();
        let deadline = s.env.ledger().timestamp() + seconds_until_deadline;
        let required = crate::internal::required_ttl_ledgers(&s.env, deadline);

        let result = s.registry.try_register_task(
            &s.admin,
            &TaskType::Liquidation,
            &calldata(&s.env),
            &1_000_000i128,
            &deadline,
            &ttl_ledgers,
            &120u32,
            &None,
        );

        if (ttl_ledgers as u64) < required {
            prop_assert_eq!(
                result,
                Err(Ok(KeeperError::TtlTooShort)),
                "ttl_ledgers below the deadline's required coverage must be rejected with TtlTooShort"
            );
        } else {
            prop_assert!(
                result.is_ok(),
                "ttl_ledgers that covers the deadline plus safety margin must be accepted"
            );
        }
    }

    // I-9 — Instance TTL liveness under randomized, bounded-gap traffic
    // (issue 0122, generalizing issue 0015's hand-written
    // `test_instance_ttl_renewed_by_mutation_stays_alive_past_initial_window`).
    // See docs/ARCHITECTURE.md's "TTL / archival strategy" section.
    //
    // `bump_instance` calls `extend_ttl(INSTANCE_BUMP_THRESHOLD,
    // INSTANCE_BUMP_LEDGERS)` on every mutating entry point: per
    // `storage::Instance::extend_ttl`'s documented semantics, that's a
    // no-op whenever the remaining TTL is already >= INSTANCE_BUMP_THRESHOLD,
    // and only resets the remaining TTL up to the full INSTANCE_BUMP_LEDGERS
    // when it was below that threshold. The only gap bound that's safe
    // between ANY two consecutive calls without inspecting live state is
    // therefore INSTANCE_BUMP_THRESHOLD, not the larger INSTANCE_BUMP_LEDGERS
    // (a call that lands while TTL is still comfortably above the threshold
    // does not buy back a fresh full-size window) -- this property pins that
    // bound directly rather than assuming the looser one.
    #[test]
    fn property_i9_instance_ttl_never_lapses_under_bounded_gap_traffic(
        gaps in prop::collection::vec(0u32..INSTANCE_BUMP_THRESHOLD, 1..8),
    ) {
        let s = setup(); // initialize() already performed one bump_instance call.

        for gap in gaps {
            advance(&s.env, gap, 0);
            let ttl = s
                .env
                .deployer()
                .get_contract_instance_ttl(&s.registry.address);
            prop_assert!(
                ttl > 0,
                "instance TTL lapsed after a {}-ledger gap despite a mutating call \
                 following it within INSTANCE_BUMP_THRESHOLD",
                gap
            );

            // Any mutating entry point calls bump_instance; this one
            // touches only instance storage, isolating instance TTL
            // renewal from the separate per-task TTL mechanism.
            s.registry.set_min_reward(&s.admin, &0i128);
        }

        let ttl_final = s
            .env
            .deployer()
            .get_contract_instance_ttl(&s.registry.address);
        prop_assert!(
            ttl_final > 0,
            "instance TTL lapsed after a sequence of bounded-gap mutating calls"
        );
    }
}
