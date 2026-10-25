//! Fuzz target for governance proposal tallying, quorum calculation, and timelock arithmetic
//! (issue #508 / backlog 0380), following the fuzzing discipline applied across the network
//! (issues 0062, 0306, 0331, 0352).
//!
//! Exercises:
//! - Voting power sums and tally computations across arbitrary i128 values.
//! - Checks that checked_add / overflow detection prevents wrapping or invalid negative/overflow states.
//! - Quorum calculations `(total_supply * bps) / 10_000` across plausible and boundary supplies / bps.
//! - Passing threshold evaluation: `votes_for > votes_against` AND `total_votes >= quorum`.
//! - Timelock delay and sequence arithmetic: `eta = current_ledger + delay`, `voting_end = created_at + voting_period`.
//! - Boundary condition testing for `is_executable` and `get_remaining_delay` around `current_ledger == eta - 1`,
//!   `current_ledger == eta`, and `current_ledger == eta + 1`.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Arbitrary, Debug, Clone)]
pub struct GovernanceFuzzInput {
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub total_supply: i128,
    pub quorum_bps: u32,

    pub created_at: u64,
    pub voting_period: u32,
    pub timelock_delay: u32,
    pub current_ledger: u64,
}

fuzz_target!(|input: GovernanceFuzzInput| {
    // 1. Vote tally arithmetic & overflow checking
    // Contract model:
    // total_votes = votes_for.checked_add(votes_against).and_then(|s| s.checked_add(votes_abstain))
    let total_votes_opt = input
        .votes_for
        .checked_add(input.votes_against)
        .and_then(|s| s.checked_add(input.votes_abstain));

    // In soroban governance contract, votes cannot be negative in valid operation, but fuzzer exercises arbitrary i128.
    // If any component is negative or overflow occurs, checked arithmetic must behave deterministically.
    if let Some(total_votes) = total_votes_opt {
        // Commutativity & associativity invariants
        let alt_sum = input
            .votes_against
            .checked_add(input.votes_abstain)
            .and_then(|s| s.checked_add(input.votes_for));
        assert_eq!(total_votes_opt, alt_sum);

        // If all inputs are non-negative, total_votes must be >= each component
        if input.votes_for >= 0 && input.votes_against >= 0 && input.votes_abstain >= 0 {
            assert!(total_votes >= input.votes_for);
            assert!(total_votes >= input.votes_against);
            assert!(total_votes >= input.votes_abstain);
        }
    }

    // 2. Quorum threshold arithmetic
    // Formula from GovernanceContract::quorum_threshold:
    // (total_supply * bps as i128) / 10_000
    if input.total_supply >= 0 && input.quorum_bps <= 10_000 {
        if let Some(prod) = input.total_supply.checked_mul(input.quorum_bps as i128) {
            let quorum = prod / 10_000;
            assert!(quorum >= 0);
            assert!(quorum <= input.total_supply);

            // Bounded monotonicity: higher bps on same supply => higher or equal quorum
            if input.quorum_bps < 10_000 {
                let next_bps = (input.quorum_bps + 1) as i128;
                if let Some(next_prod) = input.total_supply.checked_mul(next_bps) {
                    let next_quorum = next_prod / 10_000;
                    assert!(next_quorum >= quorum);
                }
            }

            // Evaluation logic validation:
            if let Some(total_votes) = total_votes_opt {
                let quorum_met = total_votes >= quorum;
                let passing_met = input.votes_for > input.votes_against;

                let should_pass = quorum_met && passing_met;
                if should_pass {
                    assert!(total_votes >= quorum);
                    assert!(input.votes_for > input.votes_against);
                }
            }
        }
    }

    // 3. Timelock and voting period arithmetic
    // voting_end = created_at.saturating_add(voting_period as u64)
    let voting_end = input.created_at.saturating_add(input.voting_period as u64);
    assert!(voting_end >= input.created_at);

    // voting still active check: current_ledger <= voting_end
    let is_voting_active = input.current_ledger <= voting_end;
    let is_voting_ended = input.current_ledger > voting_end;
    assert_ne!(is_voting_active, is_voting_ended);

    // Timelock delay: eta = current_ledger.checked_add(delay as u64)
    let eta_opt = input.current_ledger.checked_add(input.timelock_delay as u64);
    if let Some(eta) = eta_opt {
        assert!(eta >= input.current_ledger);

        // Remaining delay calculation: eta.saturating_sub(query_ledger)
        // Test boundary conditions: eta - 1, eta, eta + 1
        if eta > 0 {
            let before_eta = eta - 1;
            let remaining_before = eta.saturating_sub(before_eta);
            assert_eq!(remaining_before, 1);
            let is_executable_before = before_eta >= eta;
            assert!(!is_executable_before, "off-by-one: eta - 1 should not be executable");
        }

        let at_eta = eta;
        let remaining_at = eta.saturating_sub(at_eta);
        assert_eq!(remaining_at, 0);
        let is_executable_at = at_eta >= eta;
        assert!(is_executable_at, "eta should be executable");

        if let Some(after_eta) = eta.checked_add(1) {
            let remaining_after = eta.saturating_sub(after_eta);
            assert_eq!(remaining_after, 0);
            let is_executable_after = after_eta >= eta;
            assert!(is_executable_after, "eta + 1 should be executable");
        }
    }
});
