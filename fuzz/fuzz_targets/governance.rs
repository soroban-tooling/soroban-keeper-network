//! Fuzz target for governance vote tallying and timelock arithmetic (issue #508 / backlog 0380).
//!
//! Following the fuzzing discipline applied to every other epic's arithmetic-heavy logic
//! (issues 0062, 0306, 0331, 0352), this fuzzes the vote-tallying and timelock-boundary computations,
//! since a governance contract's correctness is unusually high-stakes given it can ultimately
//! control the entire registry's admin functions.
//!
//! Two main areas are exercised:
//! 1. **Voting-power sums and tally computations:**
//!    - Arbitrary sequences of votes with voting power drawn from the full `i128` domain
//!      via raw bytes (including negative, zero, standard token ranges, and boundary values near `i128::MAX`).
//!    - Vote choices: `0` (Against), `1` (For), `2` (Abstain), and invalid choices (> 2).
//!    - Verifies no panics occur and additions never silently overflow or wrap.
//!    - Verifies exact conservation: `for_votes + against_votes + abstain_votes == total_votes`.
//!    - Verifies quorum calculation using quotient-remainder decomposition avoids intermediate overflow.
//!    - Verifies outcome evaluation: quorum is strictly enforced, majority is strictly enforced, and ties fail.
//! 2. **Timelock boundary arithmetic:**
//!    - Exercises proposal ETA calculation (`queued_at + delay`), asserting overflow is cleanly caught.
//!    - Covers off-by-one boundary risks mirroring `contracts/keeper-registry/src/test/claim.rs`'s `lock_expired` tests:
//!      - `eta - 1`: strictly not elapsed, remaining delay equals 1.
//!      - `eta`: strictly elapsed (inclusive boundary), remaining delay equals 0.
//!      - `eta + 1`: strictly elapsed, remaining delay equals 0.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_governance::{
    calculate_tally, compute_quorum_threshold, compute_timelock_eta, evaluate_proposal_outcome,
    is_timelock_elapsed, remaining_timelock_delay, GovernanceError,
};
use libfuzzer_sys::fuzz_target;

/// Arbitrary vote description with raw bytes for voting power.
#[derive(Arbitrary, Debug, Clone)]
pub struct FuzzVote {
    pub power_bytes: [u8; 16],
    pub choice: u8,
}

/// Fuzz input encompassing arbitrary voting sequences and timelock parameters.
#[derive(Arbitrary, Debug, Clone)]
pub struct GovernanceFuzzInput {
    pub votes: Vec<FuzzVote>,
    pub total_supply_bytes: [u8; 16],
    pub quorum_bps: u32,
    pub queued_at: u64,
    pub delay: u64,
    pub eval_timestamp: u64,
}

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);
    let Ok(input) = GovernanceFuzzInput::arbitrary(&mut unstructured) else {
        return;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Voting Power Sums & Tally Computation Across Full i128 Range
    // ─────────────────────────────────────────────────────────────────────────
    let mut votes = input.votes;
    // Cap votes to prevent unbounded execution time per fuzz iteration
    votes.truncate(100);

    let vote_tuples: Vec<(i128, u32)> = votes
        .iter()
        .map(|v| (i128::from_le_bytes(v.power_bytes), v.choice as u32))
        .collect();

    let tally_res = calculate_tally(&vote_tuples);

    let has_negative_power = vote_tuples.iter().any(|&(power, _)| power < 0);
    let has_invalid_choice = vote_tuples.iter().any(|&(_, choice)| choice > 2);

    match tally_res {
        Ok(tally) => {
            // If tally calculation succeeded:
            // 1. No input had negative voting power
            assert!(
                !has_negative_power,
                "calculate_tally succeeded despite presence of negative voting power"
            );
            // 2. No input had an invalid choice (>2)
            assert!(
                !has_invalid_choice,
                "calculate_tally succeeded despite presence of invalid choice (>2)"
            );

            // 3. Exact vote conservation invariant
            assert!(tally.for_votes >= 0, "for_votes must be non-negative");
            assert!(tally.against_votes >= 0, "against_votes must be non-negative");
            assert!(tally.abstain_votes >= 0, "abstain_votes must be non-negative");
            assert!(tally.total_votes >= 0, "total_votes must be non-negative");

            let checked_sum = tally
                .for_votes
                .checked_add(tally.against_votes)
                .and_then(|v| v.checked_add(tally.abstain_votes));

            assert_eq!(
                checked_sum,
                Some(tally.total_votes),
                "Category votes must sum up exactly to total_votes"
            );

            // 4. Outcome & Quorum Evaluation
            let total_supply = i128::from_le_bytes(input.total_supply_bytes);
            let outcome_res = evaluate_proposal_outcome(&tally, total_supply, input.quorum_bps);

            if input.quorum_bps > 10_000 {
                assert_eq!(
                    outcome_res,
                    Err(GovernanceError::InvalidQuorumBps),
                    "Quorum bps > 10,000 must be rejected"
                );
            } else if total_supply < 0 {
                assert_eq!(
                    outcome_res,
                    Err(GovernanceError::InvalidVotingPower),
                    "Negative total supply must be rejected"
                );
            } else if let Ok(passed) = outcome_res {
                let quorum_threshold =
                    compute_quorum_threshold(total_supply, input.quorum_bps).unwrap();

                if passed {
                    // Passed proposals MUST meet quorum
                    assert!(
                        tally.total_votes >= quorum_threshold,
                        "Passed proposal did not meet quorum threshold"
                    );
                    // Passed proposals MUST have strict majority For > Against
                    assert!(
                        tally.for_votes > tally.against_votes,
                        "Passed proposal did not have For > Against majority"
                    );
                } else {
                    // If defeated, it MUST be because quorum was missed OR Against >= For
                    let quorum_missed = tally.total_votes < quorum_threshold;
                    let not_majority = tally.for_votes <= tally.against_votes;
                    assert!(
                        quorum_missed || not_majority,
                        "Defeated proposal had both quorum and majority"
                    );
                }
            }
        }
        Ok(Err(e)) => match e {
            GovernanceError::InvalidVotingPower => {
                assert!(
                    has_negative_power,
                    "InvalidVotingPower returned when no power was negative"
                );
            }
            GovernanceError::InvalidVoteChoice => {
                assert!(
                    has_invalid_choice,
                    "InvalidVoteChoice returned when all choices were valid"
                );
            }
            GovernanceError::ArithmeticOverflow => {
                // Verified that overflow was safely caught without silent wrapping
            }
            other => panic!("Unexpected error from calculate_tally: {other:?}"),
        },
        Err(_) => panic!("calculate_tally host-errored or panicked"),
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Timelock Boundary Arithmetic (mirroring lock_expired off-by-one tests)
    // ─────────────────────────────────────────────────────────────────────────
    let eta_res = compute_timelock_eta(input.queued_at, input.delay);

    match eta_res {
        Ok(eta) => {
            assert_eq!(
                eta,
                input.queued_at + input.delay,
                "ETA must equal queued_at + delay"
            );

            // Boundary 1: eta - 1 (strictly locked / not elapsed)
            if eta > 0 {
                let before_eta = eta - 1;
                assert!(
                    !is_timelock_elapsed(before_eta, eta),
                    "eta - 1 must not be considered elapsed"
                );
                assert_eq!(
                    remaining_timelock_delay(before_eta, eta),
                    1,
                    "remaining delay at eta - 1 must be exactly 1"
                );
            }

            // Boundary 2: exactly at eta (inclusive boundary: elapsed)
            assert!(
                is_timelock_elapsed(eta, eta),
                "at eta timelock must be elapsed"
            );
            assert_eq!(
                remaining_timelock_delay(eta, eta),
                0,
                "remaining delay at eta must be exactly 0"
            );

            // Boundary 3: eta + 1 (elapsed)
            if eta < u64::MAX {
                let after_eta = eta + 1;
                assert!(
                    is_timelock_elapsed(after_eta, eta),
                    "eta + 1 must be considered elapsed"
                );
                assert_eq!(
                    remaining_timelock_delay(after_eta, eta),
                    0,
                    "remaining delay after eta must be 0"
                );
            }

            // Arbitrary timestamp test
            let elapsed = is_timelock_elapsed(input.eval_timestamp, eta);
            let remaining = remaining_timelock_delay(input.eval_timestamp, eta);

            if input.eval_timestamp < eta {
                assert!(!elapsed);
                assert_eq!(remaining, eta - input.eval_timestamp);
                assert!(remaining > 0);
            } else {
                assert!(elapsed);
                assert_eq!(remaining, 0);
            }
        }
        Err(GovernanceError::ArithmeticOverflow) => {
            // Verified that queued_at + delay overflowed u64 and was safely caught
            assert!(
                input.queued_at.checked_add(input.delay).is_none(),
                "ArithmeticOverflow returned when queued_at + delay did not overflow"
            );
        }
        Err(other) => panic!("Unexpected error from compute_timelock_eta: {other:?}"),
    }
});
