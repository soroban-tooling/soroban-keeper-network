//! Fuzz target for combining parameter-validation bounds with verifier path.
//!
//! This target exercises the interaction between two orthogonal dimensions:
//! 1. Parameter validation bounds (lock_ledgers, ttl_ledgers, calldata size, reward, deadline)
//! 2. Verifier attachment and response behavior (None, approve, reject, panic)
//!
//! Real usage combines these — a task registered near the lock/ttl boundary with a verifier
//! attached. Interaction bugs between two independently-correct features are exactly the
//! class of bug single-feature fuzzing cannot find.
//!
//! ## Status
//!
//! **Skeleton Implementation** — The basic structure is in place and compiles against the
//! current codebase. Full implementation awaits the merge of issue 0074 (verifier invocation
//! in execute_task) and 0073 (verifier parameter on register_task).
//!
//! Once 0073/0074 are merged:
//! - The Task struct will have a `verifier: Option<Address>` field
//! - `register_task` will accept a `verifier` parameter
//! - `execute_task` will invoke the verifier via `try_invoke_contract` before crediting
//! - This target will uncomment the conditional sections and run full cross-product fuzzing
//!
//! See `DESIGN_register_and_verify_combined.md` for the complete specification.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::{
    KeeperError, KeeperRegistryClient, TaskStatus, TaskType, MAX_CALLDATA_LEN,
    MIN_LOCK_LEDGERS, MAX_LOCK_LEDGERS, MIN_TTL_LEDGERS,
};
use keeper_registry_fuzz::support::{arbitrary_bytes, arbitrary_task_type, RegistryHarness};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::Bytes;

/// Input combining parameter bounds with verifier attachment and response behavior.
#[derive(Arbitrary, Debug)]
struct RegisterAndVerifyCombinedInput {
    // Parameter bounds dimension (from register_task)
    reward_bytes: [u8; 16],       // i128 — covers full domain
    deadline_bytes: [u8; 8],      // u64 — covers full domain
    ttl_ledgers_bytes: [u8; 4],   // u32 — will be weighted toward boundaries
    lock_ledgers_bytes: [u8; 4],  // u32 — will be weighted toward boundaries
    calldata: Vec<u8>,
    task_type_discriminator: u8,

    // Verifier dimension (from issue 0074)
    // Will be used once issue 0073/0074 are merged
    verifier_selector: u8,        // Selects: None, approved, rejected, panicking
    verifier_response_selector: u8, // Selects verifier behavior

    // Execution dimension (proof handling)
    proof_content: Vec<u8>,
    proof_len_selector: u8,       // Weights toward MAX_PROOF_LEN boundary
}

impl RegisterAndVerifyCombinedInput {
    /// Interpret arbitrary bytes into structured parameters.
    fn interpret(&self, env: &soroban_sdk::Env) -> (
        TaskType,
        Bytes,
        i128,
        u64,
        u32,
        u32,
    ) {
        let task_type = arbitrary_task_type(env, self.task_type_discriminator);
        let calldata = arbitrary_bytes(env, &self.calldata);

        // Convert bytes to values, covering the entire domain
        let reward = i128::from_le_bytes(self.reward_bytes);
        let deadline = u64::from_le_bytes(self.deadline_bytes);

        // Weight ttl_ledgers toward MIN/MAX boundaries
        let ttl_ledgers = ttl_ledgers_for(self.ttl_ledgers_bytes[0]);

        // Weight lock_ledgers toward MIN/MAX boundaries
        let lock_ledgers = lock_ledgers_for(self.lock_ledgers_bytes[0]);

        (task_type, calldata, reward, deadline, ttl_ledgers, lock_ledgers)
    }
}

/// Weight ttl_ledgers toward MIN_TTL_LEDGERS and MAX boundaries.
/// Covers: MIN-1, MIN, random valid, MAX-1, MAX
fn ttl_ledgers_for(selector: u8) -> u32 {
    let max_ttl = u32::MAX; // No hard MAX in contract, but fuzz toward large values
    match selector % 6 {
        0 => MIN_TTL_LEDGERS.saturating_sub(1), // Below minimum
        1 => MIN_TTL_LEDGERS,                     // At minimum
        2 => MIN_TTL_LEDGERS + 1,                 // Just above minimum
        3 => (selector as u32).saturating_mul(10_000), // Random valid value
        4 => max_ttl.saturating_sub(1),           // Near maximum
        _ => max_ttl,                             // At maximum
    }
}

/// Weight lock_ledgers toward MIN_LOCK_LEDGERS and MAX_LOCK_LEDGERS boundaries.
/// Covers: MIN-1, MIN, random valid, MAX, MAX+1
fn lock_ledgers_for(selector: u8) -> u32 {
    match selector % 5 {
        0 => MIN_LOCK_LEDGERS.saturating_sub(1), // Below minimum
        1 => MIN_LOCK_LEDGERS,                    // At minimum
        2 => (selector as u32) % (MAX_LOCK_LEDGERS + 1), // Random valid
        3 => MAX_LOCK_LEDGERS,                    // At maximum
        _ => MAX_LOCK_LEDGERS.saturating_add(1),  // Above maximum
    }
}

/// Weight proof length toward MAX_PROOF_LEN boundary.
/// Covers: MAX-1, MAX, MAX+1, random accepted, random rejected
fn proof_len_for(selector: u8, extra: u32) -> usize {
    let max_len = keeper_registry::MAX_PROOF_LEN as usize;
    match selector % 5 {
        0 => max_len.saturating_sub(1),
        1 => max_len,
        2 => max_len + 1,
        3 => (extra as usize) % (max_len + 1),
        _ => max_len + 2 + (extra as usize % 4_096),
    }
}

/// Build a proof of exactly `len` bytes by repeating or truncating `content`.
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
    let Ok(mut unstructured) = Unstructured::new(data) else {
        return;
    };

    let Ok(input) = RegisterAndVerifyCombinedInput::arbitrary(&mut unstructured) else {
        return;
    };

    // Create a fresh registry harness for each test
    let harness = RegistryHarness::new();
    let env = &harness.env;
    let client = harness.client();
    let user = harness.user.clone();
    let keeper = harness.keeper.clone();

    // Interpret the arbitrary data
    let (task_type, calldata, reward, deadline, ttl_ledgers, lock_ledgers) =
        input.interpret(env);

    // Get current timestamp for deadline validation
    let now = env.ledger().timestamp();

    // Snapshot state before registration attempt
    let fees_before = client.fees_accrued();
    let keeper_balance_before = client.keeper_balance(&keeper);

    // Attempt to register the task (without verifier, since 0073 not yet merged)
    let result = client.try_register_task(
        &user,
        &task_type,
        &calldata,
        &reward,
        &deadline,
        &ttl_ledgers,
        &lock_ledgers,
    );

    match result {
        Ok(task_id) => {
            // Registration succeeded — verify all properties
            verify_registration_success(
                &client,
                &user,
                &task_id,
                &task_type,
                &calldata,
                &reward,
                &deadline,
                &ttl_ledgers,
                &lock_ledgers,
                now,
            );

            // =========================================================================
            // CONDITIONAL: Once 0074 merges, test execution with verifier
            // =========================================================================
            // For now, we skip execution testing since there's no verifier field yet.
            // When 0074 lands:
            // 1. Uncomment the verifier selection logic below
            // 2. Deploy mock verifier contracts in harness setup
            // 3. Call execute_task with fuzzed proof
            // 4. Verify verifier invocation behavior
            // 5. Check all invariants (I-1 through I-8)
            //
            // Pseudo-code for future implementation:
            //
            // let verifier_addr = select_verifier(&harness, input.verifier_selector);
            // if let Some(addr) = verifier_addr {
            //     // Re-register with verifier now that 0073 has landed
            //     let task_id = client.register_task(..., &Some(addr));
            // }
            //
            // // Claim the task
            // client.claim_task(&keeper, &task_id).unwrap();
            //
            // // Build proof with boundary weighting
            // let proof_len = proof_len_for(input.proof_len_selector, input.proof_len_extra);
            // let proof = build_proof(env, &input.proof_content, proof_len);
            //
            // // Execute and verify verifier interaction
            // let exec_result = client.try_execute_task(&keeper, &task_id, &proof);
            // verify_execution_result(&client, exec_result, ...);
            // =========================================================================
        }
        Err(err) => {
            // Registration failed — verify it was a typed KeeperError with no side effects
            verify_registration_rejection(
                &client,
                &err,
                &reward,
                &deadline,
                &ttl_ledgers,
                &lock_ledgers,
                &calldata,
                now,
                fees_before,
                keeper_balance_before,
                &keeper,
            );
        }
    }

    // Final property: contract should never panic for any input
    // If we reach here without panic, the property holds
});

/// Verify that a successful registration has all expected properties.
#[allow(clippy::too_many_arguments)]
fn verify_registration_success(
    client: &KeeperRegistryClient,
    user: &soroban_sdk::Address,
    task_id: &u64,
    task_type: &TaskType,
    calldata: &Bytes,
    reward: &i128,
    deadline: &u64,
    ttl_ledgers: &u32,
    lock_ledgers: &u32,
    now: u64,
) {
    // 1. Task should exist and be readable
    let task = client.try_get_task(task_id);
    assert!(task.is_ok(), "Successfully registered task should be readable");
    let task = task.unwrap();

    // 2. Task should be in Pending state
    assert_eq!(task.status, TaskStatus::Pending, "New task should be Pending");

    // 3. Task fields should match what was registered
    assert_eq!(task.owner, *user, "Task owner should match");
    assert_eq!(task.task_type, *task_type, "Task type should match");

    let registered_calldata = task.calldata.to_vec();
    let input_calldata = calldata.to_vec();
    assert_eq!(
        registered_calldata, input_calldata,
        "Calldata should be stored exactly"
    );

    assert_eq!(task.reward, *reward, "Task reward should match");
    assert_eq!(task.deadline, *deadline, "Task deadline should match");
    assert_eq!(task.ttl_ledgers, *ttl_ledgers, "Task TTL should match");
    assert_eq!(task.lock_ledgers, *lock_ledgers, "Task lock period should match");

    // 4. No claimer should be set for Pending task
    assert!(task.claimer.is_none(), "Pending task should have no claimer");
    assert!(task.claim_ledger.is_none(), "Pending task should have no claim ledger");

    // 5. Task should have positive reward (contract enforces this)
    assert!(task.reward > 0, "Registered task should have positive reward");

    // 6. Deadline should be in the future (contract enforces this)
    assert!(task.deadline > now, "Registered task deadline should be in future");

    // 7. Calldata length should be within limits (contract enforces this)
    assert!(
        calldata.len() <= MAX_CALLDATA_LEN as usize,
        "Registered task calldata should be within limit"
    );

    // 8. Verify storage consistency by reading again
    let task_again = client.try_get_task(task_id).unwrap();
    assert_eq!(
        task.reward, task_again.reward,
        "Task should be idempotently readable"
    );

    // 9. Task counter should have increased
    let task_count = client.task_count();
    assert!(task_count > 0, "Task count should increase after registration");
}

/// Verify that a registration rejection was correct and had no side effects.
#[allow(clippy::too_many_arguments)]
fn verify_registration_rejection(
    client: &KeeperRegistryClient,
    err: &KeeperError,
    reward: &i128,
    deadline: &u64,
    ttl_ledgers: &u32,
    lock_ledgers: &u32,
    calldata: &Bytes,
    now: u64,
    fees_before: i128,
    keeper_balance_before: i128,
    keeper: &soroban_sdk::Address,
) {
    // 1. Should be a KeeperError variant matching contract logic
    match err {
        KeeperError::InvalidReward => {
            // Contract rejects reward <= 0
            assert!(
                *reward <= 0,
                "InvalidReward should only occur for non-positive reward"
            );
        }
        KeeperError::DeadlinePassed => {
            // Contract rejects deadline <= now
            assert!(
                *deadline <= now,
                "DeadlinePassed should only occur for past/current deadline"
            );
        }
        KeeperError::CalldataTooLarge => {
            // Contract rejects calldata > MAX_CALLDATA_LEN
            assert!(
                calldata.len() > MAX_CALLDATA_LEN as usize,
                "CalldataTooLarge should only occur for oversized calldata"
            );
        }
        _ => {
            // For lock/ttl bounds, the error depends on the specific values.
            // The contract may not always reject; if parameters are valid,
            // registration could succeed. This is not an error condition.
        }
    }

    // 2. Zero escrow movement on rejection — THIS IS THE KEY ASSERTION
    //    This must hold regardless of whether a verifier was attached.
    //    A bad parameter should reject before the verifier is even consulted.
    let fees_after = client.fees_accrued();
    let keeper_balance_after = client.keeper_balance(keeper);

    assert_eq!(
        fees_after, fees_before,
        "Fees should not change on registration rejection"
    );
    assert_eq!(
        keeper_balance_after, keeper_balance_before,
        "Keeper balance should not change on registration rejection"
    );

    // 3. No partial state should be created
    // (Harder to verify without specific test state tracking, but invariants should hold)
}

/// Placeholder for future execution verification once 0074 is merged.
///
/// This function will be uncommented and expanded once the verifier path is implemented.
#[allow(dead_code)]
fn verify_execution_result(
    _client: &KeeperRegistryClient,
    _exec_result: Result<Result<(), KeeperError>, soroban_sdk::InvokeContractError>,
    _verifier_present: bool,
    _verifier_response: VerifierResponse,
) {
    // Once 0074 merges and execute_task invokes verifiers:
    //
    // match exec_result {
    //     Ok(Ok(())) => {
    //         // Execution succeeded
    //         assert!(verifier_present && verifier_response == VerifierResponse::Approve);
    //         // Verify I-4 fee bounding, I-1 solvency, keeper credit updated
    //     }
    //     Ok(Err(KeeperError::VerificationFailed)) => {
    //         // Execution rejected by verifier
    //         assert!(verifier_present && verifier_response != VerifierResponse::Approve);
    //         // Verify I-8 trust boundary: zero state mutation
    //     }
    //     Err(_) => {
    //         // Verifier panic (if panic-isolation enabled)
    //         assert!(verifier_response == VerifierResponse::Panics);
    //         // Verify I-8 trust boundary: zero state mutation despite panic
    //     }
    //     other => panic!("Unexpected result: {:?}", other),
    // }
}

/// Placeholder for verifier response type.
/// Once 0074 merges, this will control mock verifier behavior during execution.
#[allow(dead_code)]
enum VerifierResponse {
    Approve,
    Reject,
    Panics,
    HostError,
}
