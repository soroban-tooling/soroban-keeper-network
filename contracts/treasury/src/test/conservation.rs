//! Property test: distribution never creates or destroys value.
//!
//! A dedicated conservation property for the treasury, in the same spirit as
//! the registry's own I-1 solvency invariant
//! (`contracts/keeper-registry/src/invariants.rs::assert_solvent`,
//! exercised by `contracts/keeper-registry/src/test/property.rs`).
//!
//! Two identities are checked after every step of a randomized sequence of
//! distributions and recipient reconfigurations:
//!
//! - **Solvency**: the treasury's token balance always equals the sum of
//!   every recipient's currently-withdrawable balance — i.e. exactly what
//!   remains credited but not yet withdrawn. `distribute` only ever pulls in
//!   what it credits (see `distribution.rs`), and `withdraw` moves out
//!   exactly what it zeroes, so these two numbers can never drift apart.
//! - **Lifetime accounting**: the contract's own `total_distributed()`
//!   accumulator always equals the sum of every recipient's
//!   `recipient_total_received()` — the running lifetime total is not a
//!   separate figure that could fall out of sync with what recipients were
//!   actually credited, it is definitionally the same sum, kept as an
//!   accumulator purely so an indexer doesn't have to replay every
//!   `Distributed` event to reconstruct it.
//!
//! A second, focused property confirms that reweighting a recipient's share
//! mid-sequence never retroactively touches a distribution that already
//! happened — only future `distribute` calls see the new weight.

// This module only compiles under cfg(test), where std is always linked.
extern crate std;

use soroban_sdk::{testutils::Address as _, token, Address};
use std::vec::Vec as StdVec;

use super::common::*;
use proptest::prelude::*;

/// One step in a randomized sequence: an amount to distribute, or a
/// recipient-configuration change. Encoded as a small integer so proptest can
/// shrink it, decoded against the fixed pool of recipients (`recipient_at`)
/// created up front by `run_sequence`.
#[derive(Clone, Debug)]
enum Step {
    Distribute(i128),
    AddOrReweight {
        recipient_idx: usize,
        shares_bps: u32,
    },
    Remove {
        recipient_idx: usize,
    },
}

fn step_strategy() -> impl Strategy<Value = Step> {
    prop_oneof![
        (1_i128..500_000).prop_map(Step::Distribute),
        (0usize..4, 1u32..10_000).prop_map(|(recipient_idx, shares_bps)| Step::AddOrReweight {
            recipient_idx,
            shares_bps
        }),
        (0usize..4).prop_map(|recipient_idx| Step::Remove { recipient_idx }),
    ]
}

/// Asserts both conservation identities against the setup's current state,
/// restricted to the fixed pool of `known` recipients the sequence draws
/// from — the contract has no "list all recipients that ever existed" view,
/// so, like the registry's own invariant helpers, the caller supplies every
/// address it could possibly have registered.
fn assert_conserved(s: &TestSetup, known: &[Address]) -> Result<(), TestCaseError> {
    let token = token::Client::new(&s.env, &s.token_id);

    let mut balance_sum: i128 = 0;
    let mut received_sum: i128 = 0;
    for r in known {
        balance_sum += s.treasury.recipient_balance(r);
        received_sum += s.treasury.recipient_total_received(r);
    }

    prop_assert_eq!(
        token.balance(&s.treasury.address),
        balance_sum,
        "treasury token balance must equal the sum of every recipient's withdrawable balance"
    );
    prop_assert_eq!(
        s.treasury.total_distributed(),
        received_sum,
        "total_distributed() must equal the sum of every recipient's lifetime-received total"
    );
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn property_conservation_holds_across_random_distribution_and_reconfiguration_sequences(
        steps in prop::collection::vec(step_strategy(), 1..20),
    ) {
        let s = setup();
        let known: StdVec<Address> = (0..4).map(|_| Address::generate(&s.env)).collect();

        for step in steps {
            match step {
                Step::Distribute(amount) => {
                    // A distribution with no registered recipients (or all
                    // zero-share) is a rejected call, not a conservation
                    // violation — just skip it and keep going.
                    let _ = s.treasury.try_distribute(&s.admin, &amount);
                }
                Step::AddOrReweight { recipient_idx, shares_bps } => {
                    let r = &known[recipient_idx];
                    if s.treasury.recipients().iter().any(|rec| rec.address == *r) {
                        let _ = s.treasury.try_update_recipient_shares(&s.admin, r, &shares_bps);
                    } else {
                        let _ = s.treasury.try_add_recipient(&s.admin, r, &shares_bps);
                    }
                }
                Step::Remove { recipient_idx } => {
                    let r = &known[recipient_idx];
                    let _ = s.treasury.try_remove_recipient(&s.admin, r);
                }
            }

            assert_conserved(&s, &known)?;
        }
    }

    // Recipient-share reweighting mid-sequence must never retroactively
    // alter the correctness of a distribution that already completed: a
    // recipient's balance and lifetime-received total from before the
    // reweight are exactly what they were, plus only what later
    // `distribute` calls credit under the *new* weight.
    #[test]
    fn property_reweighting_never_retroactively_alters_completed_distributions(
        first_amount in 1_i128..500_000,
        second_amount in 1_i128..500_000,
        initial_shares in 1u32..10_000,
        reweighted_shares in 1u32..10_000,
    ) {
        let s = setup();
        let r1 = Address::generate(&s.env);
        let r2 = Address::generate(&s.env);
        s.treasury.add_recipient(&s.admin, &r1, &initial_shares);
        s.treasury.add_recipient(&s.admin, &r2, &initial_shares);

        s.treasury.distribute(&s.admin, &first_amount);
        let r1_balance_after_first = s.treasury.recipient_balance(&r1);
        let r1_received_after_first = s.treasury.recipient_total_received(&r1);

        s.treasury.update_recipient_shares(&s.admin, &r1, &reweighted_shares);

        // The reweight alone (no distribute call) must not have touched
        // anything already credited.
        prop_assert_eq!(s.treasury.recipient_balance(&r1), r1_balance_after_first);
        prop_assert_eq!(
            s.treasury.recipient_total_received(&r1),
            r1_received_after_first
        );

        s.treasury.distribute(&s.admin, &second_amount);

        // Whatever the second distribution credited was added on top of —
        // never in place of — the pre-reweight totals.
        prop_assert!(s.treasury.recipient_balance(&r1) >= r1_balance_after_first);
        prop_assert!(
            s.treasury.recipient_total_received(&r1) >= r1_received_after_first
        );
        let second_credit = s.treasury.recipient_total_received(&r1) - r1_received_after_first;
        prop_assert_eq!(
            s.treasury.recipient_balance(&r1),
            r1_balance_after_first + second_credit,
            "the second distribution's credit must be additive on top of the pre-reweight balance"
        );
    }
}
