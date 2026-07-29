//! Fuzz target for execute_task's proof handling and reward-split arithmetic.
//!
//! This target registers and claims a task with a fuzzer-chosen reward and
//! fee_bps, then calls execute_task with fuzzer-chosen proof bytes. It
//! verifies:
//! - Contract never panics for any proof input (including empty, oversized,
//!   and boundary-length proofs)
//! - Oversized proof is rejected with the typed `ProofTooLarge` error, never
//!   a panic
//! - A successful execution's reward split satisfies I-4 (fee bounding) via
//!   the SAME `assert_fee_bounded` check the property tests in `test.rs`
//!   use — see `keeper_registry::invariants` for why this is shared rather
//!   than duplicated (issue #93 / backlog 0068).
//! - After a successful execution, I-1 (solvency) holds for this task's
//!   contribution: the keeper's credited balance plus the accrued fee
//!   exactly equals the escrowed reward.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::invariants::assert_fee_bounded;
use keeper_registry::{split_reward, KeeperError, TaskType};
use keeper_registry_fuzz::support::{arbitrary_bytes, RegistryHarness};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::Bytes;

/// Arbitrary input data for execute_task fuzzing.
#[derive(Arbitrary, Debug)]
struct ExecuteTaskInput {
    reward_bytes: [u8; 16], // i128
    fee_bps_bytes: [u8; 4], // u32, later clamped to [0, 10_000]
    proof: Vec<u8>,
}

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);

    let Ok(input) = ExecuteTaskInput::arbitrary(&mut unstructured) else {
        return;
    };

    // Reward must be positive for register_task to accept it; fee_bps is
    // clamped to the contract's valid range (set_fee_bps enforces
    // fee_bps <= 10_000 elsewhere, and initialize takes the same bound) so
    // this target spends its entropy budget on the proof, not on
    // rediscovering the already-covered fee_bps validation boundary.
    let reward = i128::from_le_bytes(input.reward_bytes).unsigned_abs() as i128 % 1_000_000_000
        + 1;
    let fee_bps = u32::from_le_bytes(input.fee_bps_bytes) % 10_001;

    let harness = RegistryHarness::new();
    let env = &harness.env;
    let client = harness.client();

    // Reconfigure the harness's default 0% fee to this run's fuzzed rate.
    client.set_fee_bps(&harness.admin, &fee_bps);

    let deadline = env.ledger().timestamp() + 1_000;
    let task_id = client.register_task(
        &harness.user,
        &TaskType::Liquidation,
        &Bytes::from_slice(env, b""),
        &reward,
        &deadline,
        &1_000u32,
        &100u32,
    );

    client.claim_task(&harness.keeper, &task_id);

    let proof = arbitrary_bytes(env, &input.proof);
    let fees_before = client.fees_accrued();

    let result = client.try_execute_task(&harness.keeper, &task_id, &proof);

    match result {
        Ok(Ok(())) => {
            // Successful execution — the proof must have been within bounds.
            assert!(
                proof.len() <= keeper_registry::MAX_PROOF_LEN,
                "execute_task succeeded with an over-long proof ({} bytes)",
                proof.len()
            );

            let (expected_keeper_net, expected_fee) = split_reward(reward, fee_bps);

            // I-4 — fee bounding, via the SAME assertion the property
            // tests use (not a parallel copy).
            assert_fee_bounded(reward, fee_bps, expected_keeper_net, expected_fee)
                .expect("I-4 fee bounding must hold for a successful execution");

            let keeper_balance = client.keeper_balance(&harness.keeper);
            assert_eq!(
                keeper_balance, expected_keeper_net,
                "keeper_balance ({keeper_balance}) should equal the computed net reward \
                 ({expected_keeper_net}) after execution"
            );

            let fees_after = client.fees_accrued();
            assert_eq!(
                fees_after,
                fees_before + expected_fee,
                "fees_accrued should increase by exactly the computed fee"
            );

            // I-1 (solvency), restricted to this single task's contribution:
            // every stroop of the escrowed reward is now accounted for
            // between the keeper's credit and the accrued fee.
            assert_eq!(
                keeper_balance + (fees_after - fees_before),
                reward,
                "keeper credit + fee delta must exactly equal the original escrowed reward"
            );
        }
        Ok(Err(_)) => {
            panic!(
                "execute_task returned Ok(()) but the value failed to convert back from the \
                 host — this indicates a client/ABI mismatch, not a contract-logic rejection"
            );
        }
        Err(Ok(e)) => {
            // Rejected — must be a typed error the contract's documented
            // preconditions predict, never an unexpected variant.
            match e {
                KeeperError::ProofTooLarge => {
                    assert!(
                        proof.len() > keeper_registry::MAX_PROOF_LEN,
                        "ProofTooLarge returned for a proof within the length limit"
                    );
                }
                KeeperError::ContractPaused
                | KeeperError::InvalidTaskStatus
                | KeeperError::NotTaskClaimer
                | KeeperError::DeadlinePassed
                | KeeperError::TaskNotFound
                | KeeperError::NotInitialized => {
                    // These can't happen given this harness's fixed setup
                    // (single fresh task, single keeper, always-initialized,
                    // never paused, deadline always in the future at claim
                    // time) — reaching one of them here would itself be a
                    // bug worth investigating, so fail loudly rather than
                    // silently accepting any typed error.
                    panic!("unexpected KeeperError for this harness's fixed setup: {e:?}");
                }
                other => {
                    panic!("execute_task returned an unexpected KeeperError variant: {other:?}");
                }
            }
        }
        Err(Err(_)) => {
            panic!("execute_task host-errored instead of returning a typed KeeperError");
        }
    }
});
