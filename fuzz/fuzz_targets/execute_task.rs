//! Fuzz target for execute_task's proof handling and reward-split arithmetic.
//!
//! This target registers and claims a task with a fuzzer-chosen reward and
//! fee_bps, then calls execute_task with a fuzzer-chosen proof. It
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
//!
//! ## Proof-length boundary coverage (issue 0123)
//!
//! Rather than letting `arbitrary` pick an unweighted-random proof length
//! (which rarely lands exactly on `MAX_PROOF_LEN`'s boundary), the proof
//! length is explicitly weighted toward it: `MAX_PROOF_LEN - 1` (accepted),
//! exactly `MAX_PROOF_LEN` (accepted), `MAX_PROOF_LEN + 1` (rejected), a
//! random accepted length anywhere in `[0, MAX_PROOF_LEN]`, and a random
//! rejected length further out. On every acceptance, the emitted
//! `TaskExecuted` event's proof field is compared byte-for-byte against the
//! input proof — not just checked for presence — so this is exercised at
//! every one of those accepted lengths across fuzzing runs, not just one
//! arbitrary accepted length. This extends issue 0053's target in place
//! (per issue 0123: "extend it if it exists") rather than duplicating it.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::invariants::assert_fee_bounded;
use keeper_registry::{split_reward, KeeperError, TaskType};
use keeper_registry_fuzz::support::RegistryHarness;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Events as _, Bytes, TryIntoVal};

/// Arbitrary input data for execute_task fuzzing.
#[derive(Arbitrary, Debug)]
struct ExecuteTaskInput {
    reward_bytes: [u8; 16], // i128
    fee_bps_bytes: [u8; 4], // u32, later clamped to [0, 10_000]
    /// Selects which region of the proof-length space this run targets —
    /// see `proof_len_for`.
    proof_len_selector: u8,
    /// Drives the two length categories that aren't a single fixed value
    /// (the random-in-bounds and random-out-of-bounds cases).
    proof_len_extra: u32,
    /// Repeated/truncated to the chosen length to fill the proof — see
    /// `build_proof`.
    proof_content: Vec<u8>,
}

/// Weights the proof length toward `MAX_PROOF_LEN`'s boundary rather than
/// leaving it to unweighted `arbitrary` generation, per issue 0123's
/// acceptance criteria: exactly one under, exactly at, exactly one over,
/// plus randomized values on both sides of the limit for broader coverage.
fn proof_len_for(selector: u8, extra: u32) -> usize {
    let max_len = keeper_registry::MAX_PROOF_LEN as usize;
    match selector % 5 {
        0 => max_len.saturating_sub(1),
        1 => max_len,
        2 => max_len + 1,
        3 => (extra as usize) % (max_len + 1), // random accepted length
        _ => max_len + 2 + (extra as usize % 4_096), // random rejected length, further out
    }
}

/// Builds a proof of exactly `len` bytes by repeating (or truncating)
/// `content`, so a short `arbitrary`-generated content slice can still fill
/// a proof up to `MAX_PROOF_LEN + 1` bytes deterministically.
fn build_proof(env: &soroban_sdk::Env, content: &[u8], len: usize) -> Bytes {
    if content.is_empty() {
        return Bytes::from_slice(env, &vec![0u8; len]);
    }
    let mut bytes = std::vec::Vec::with_capacity(len);
    while bytes.len() < len {
        let remaining = len - bytes.len();
        let take = remaining.min(content.len());
        bytes.extend_from_slice(&content[..take]);
    }
    Bytes::from_slice(env, &bytes)
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
        &None,
    );

    client.claim_task(&harness.keeper, &task_id);

    let proof_len = proof_len_for(input.proof_len_selector, input.proof_len_extra);
    let proof = build_proof(env, &input.proof_content, proof_len);
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

            // The accepted proof must be faithfully emitted in the
            // TaskExecuted event — byte-for-byte, not just "present" — at
            // THIS accepted length. Across fuzzing runs `proof_len_for`
            // drives this through MAX_PROOF_LEN - 1, exactly MAX_PROOF_LEN,
            // and random shorter lengths, so this assertion is exercised at
            // multiple distinct accepted lengths, not just one.
            let (_contract, _topics, event_data) = env
                .events()
                .all()
                .last()
                .expect("execute_task succeeded, so it must have emitted TaskExecuted");
            let (_event_task_id, _event_keeper, _event_net, event_proof): (
                u64,
                soroban_sdk::Address,
                i128,
                Bytes,
            ) = event_data
                .try_into_val(env)
                .expect("TaskExecuted event data must decode to the documented tuple shape");
            assert_eq!(
                event_proof,
                proof,
                "TaskExecuted's emitted proof (len {}) must match the input proof \
                 (len {}) exactly at accepted length {}",
                event_proof.len(),
                proof.len(),
                proof_len
            );

            let (expected_keeper_net, expected_fee) = split_reward(reward, fee_bps)
                .expect("execute_task already succeeded, so split_reward must too");


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
