//! Fuzz target for the staking entry points' arithmetic (issue #434 /
//! backlog 0306), following the harness epic E03 established (issue 0051)
//! and the same `try_*` double-`Result` handling pattern `execute_task.rs`
//! uses (issue 0062's target).
//!
//! Exercises `stake_deposit`, `initiate_unbond`, `withdraw_stake`, and
//! `slash` with amounts drawn from the full `i128` range (not just the
//! contract's currently-validated positive range), and verifies:
//! - No input panics the contract; every rejection is a typed `KeeperError`.
//! - A deposit never leaves `keeper_stake` inconsistent with the amount
//!   actually transferred in.
//! - `initiate_unbond`/`slash` never accept an amount exceeding the
//!   keeper's current stake (`InsufficientStake`, never a silent
//!   underflow).
//! - The specific boundary interaction issue 0306 calls out by name: a
//!   partial unbond followed by a slash request larger than the remaining
//!   non-unbonding stake must be rejected with `InsufficientStake`, and
//!   must never reduce `keeper_stake` below zero.
//! - Any crash this target finds gets a minimized regression test in
//!   `test/staking.rs`, per the process issue 0069 established.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::KeeperError;
use keeper_registry_fuzz::support::RegistryHarness;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{symbol_short, testutils::Address as _, token, Address};

/// Arbitrary input for one staking-arithmetic run: an initial deposit, a
/// partial unbond, and a slash attempt, all amounts drawn from the full
/// `i128` domain via raw bytes (not pre-clamped to a "reasonable" range —
/// the point, per 0306, is to find out what happens with an unvalidated
/// input reaching this function from a future caller that doesn't
/// pre-filter the way this target's own harness setup does).
#[derive(Arbitrary, Debug)]
struct StakingInput {
    deposit_bytes: [u8; 16],
    unbond_bytes: [u8; 16],
    slash_bytes: [u8; 16],
    /// Whether to actually call `initiate_unbond` this run at all — a
    /// zero-amount unbond and "never called unbond" are meaningfully
    /// different, and the fixed 0..2 byte keeps that distinction sampled
    /// roughly evenly rather than relying on `unbond_bytes` happening to
    /// decode to zero.
    call_unbond: bool,
}

fn i128_from(bytes: [u8; 16]) -> i128 {
    i128::from_le_bytes(bytes)
}

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);
    let Ok(input) = StakingInput::arbitrary(&mut unstructured) else {
        return;
    };

    let harness = RegistryHarness::new();
    let env = &harness.env;
    let client = harness.client();
    let keeper = Address::generate(env);
    let treasury = Address::generate(env);

    let deposit = i128_from(input.deposit_bytes);
    let unbond_amount = i128_from(input.unbond_bytes);
    let slash_amount = i128_from(input.slash_bytes);

    // Mint enough for the deposit attempt regardless of whether it's
    // negative/zero/positive — a non-positive deposit is rejected before
    // any transfer is attempted, so minting unconditionally is harmless and
    // avoids the token client itself rejecting a negative mint amount
    // before the contract call under test even runs.
    if deposit > 0 {
        token::StellarAssetClient::new(env, &harness.reward_token).mint(&keeper, &deposit);
    }

    let deposit_result = client.try_stake_deposit(&keeper, &deposit);

    match deposit_result {
        Ok(Ok(())) => {
            assert!(
                deposit > 0,
                "stake_deposit succeeded for a non-positive amount ({deposit})"
            );
            let stake = client.keeper_stake(&keeper);
            assert_eq!(
                stake, deposit,
                "keeper_stake ({stake}) must equal the single deposited amount ({deposit})"
            );
        }
        Ok(Err(e)) => {
            assert_eq!(
                e,
                KeeperError::InvalidReward,
                "unexpected rejection reason for a non-positive stake_deposit amount: {e:?}"
            );
            assert!(
                deposit <= 0,
                "InvalidReward returned for a positive deposit amount ({deposit})"
            );
        }
        Err(_) => panic!("stake_deposit host-errored instead of returning a typed KeeperError"),
    }

    let stake_after_deposit = client.keeper_stake(&keeper);

    if input.call_unbond {
        let unbond_result = client.try_initiate_unbond(&keeper, &unbond_amount);
        match unbond_result {
            Ok(Ok(())) => {
                assert!(
                    unbond_amount > 0 && unbond_amount <= stake_after_deposit,
                    "initiate_unbond succeeded for amount {unbond_amount} against stake \
                     {stake_after_deposit}"
                );
                let stake_after_unbond = client.keeper_stake(&keeper);
                assert_eq!(
                    stake_after_unbond,
                    stake_after_deposit - unbond_amount,
                    "keeper_stake did not decrease by exactly the unbonded amount"
                );
                assert!(
                    stake_after_unbond >= 0,
                    "keeper_stake went negative after initiate_unbond: {stake_after_unbond}"
                );
            }
            Ok(Err(e)) => match e {
                KeeperError::InvalidReward => {
                    assert!(unbond_amount <= 0, "InvalidReward for a positive unbond amount");
                }
                KeeperError::InsufficientStake => {
                    assert!(
                        unbond_amount > stake_after_deposit,
                        "InsufficientStake returned for an unbond amount within current stake"
                    );
                }
                other => panic!("unexpected initiate_unbond rejection: {other:?}"),
            },
            Err(_) => {
                panic!("initiate_unbond host-errored instead of returning a typed KeeperError")
            }
        }
    }

    // The boundary issue 0306 names explicitly: after any partial unbond
    // above, attempt to slash more than what remains bonded. This must
    // never succeed, never underflow, and never leave keeper_stake
    // negative.
    let stake_before_slash = client.keeper_stake(&keeper);
    let slash_result =
        client.try_slash(&harness.admin, &keeper, &slash_amount, &symbol_short!("test"), &treasury);

    match slash_result {
        Ok(Ok(_slash_id)) => {
            assert!(
                slash_amount > 0 && slash_amount <= stake_before_slash,
                "slash succeeded for amount {slash_amount} against stake {stake_before_slash}"
            );
            let stake_after_slash = client.keeper_stake(&keeper);
            assert_eq!(
                stake_after_slash,
                stake_before_slash - slash_amount,
                "keeper_stake did not decrease by exactly the slashed amount"
            );
            assert!(
                stake_after_slash >= 0,
                "keeper_stake went negative after slash: {stake_after_slash}"
            );
        }
        Ok(Err(e)) => match e {
            KeeperError::InvalidReward => {
                assert!(slash_amount <= 0, "InvalidReward for a positive slash amount");
            }
            KeeperError::InsufficientStake => {
                // This is exactly the case issue 0306 calls out: a slash
                // request larger than the keeper's remaining (post-unbond)
                // stake must be rejected this way, never underflow.
                assert!(
                    slash_amount > stake_before_slash,
                    "InsufficientStake returned for a slash amount within current stake"
                );
            }
            other => panic!("unexpected slash rejection: {other:?}"),
        },
        Err(_) => panic!("slash host-errored instead of returning a typed KeeperError"),
    }

    let final_stake = client.keeper_stake(&keeper);
    assert!(
        final_stake >= 0,
        "keeper_stake is negative at the end of the run: {final_stake}"
    );
});
