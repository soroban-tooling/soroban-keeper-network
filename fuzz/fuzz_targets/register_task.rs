//! Fuzz target for register_task parameter space.
//!
//! This target exercises the full input space of register_task:
//! - reward: entire i128 domain (including MIN, MAX, zero, negative, positive, boundaries)
//! - deadline: entire u64 range
//! - ttl_ledgers: entire u32 range
//! - lock_ledgers: entire u32 range
//! - calldata: arbitrary Bytes (empty, small, medium, extremely large)
//!
//! The target verifies:
//! - Contract never panics for any input
//! - All rejections are typed KeeperError (not panics)
//! - Successful registrations remain readable and consistent
//! - No host aborts or traps occur

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::{
    KeeperError, KeeperRegistryClient, TaskStatus, TaskType, MAX_CALLDATA_LEN,
};
use keeper_registry_fuzz::support::{arbitrary_bytes, arbitrary_task_type, RegistryHarness};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::Bytes;

/// Arbitrary input data for register_task fuzzing.
#[derive(Arbitrary, Debug)]
struct RegisterTaskInput {
    // Use raw bytes and reinterpret to cover entire ranges
    reward_bytes: [u8; 16],      // i128 is 16 bytes
    deadline_bytes: [u8; 8],    // u64 is 8 bytes
    ttl_ledgers_bytes: [u8; 4], // u32 is 4 bytes
    lock_ledgers_bytes: [u8; 4], // u32 is 4 bytes
    calldata: Vec<u8>,
    task_type_discriminator: u8,
}

impl RegisterTaskInput {
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
        let ttl_ledgers = u32::from_le_bytes(self.ttl_ledgers_bytes);
        let lock_ledgers = u32::from_le_bytes(self.lock_ledgers_bytes);
        
        (task_type, calldata, reward, deadline, ttl_ledgers, lock_ledgers)
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(mut unstructured) = Unstructured::new(data) else {
        return;
    };
    
    let Ok(input) = RegisterTaskInput::arbitrary(&mut unstructured) else {
        return;
    };
    
    // Create a fresh registry harness for each test
    let harness = RegistryHarness::new();
    let env = &harness.env;
    let client = harness.client();
    let user = harness.user.clone();
    
    // Interpret the arbitrary data
    let (task_type, calldata, reward, deadline, ttl_ledgers, lock_ledgers) =
        input.interpret(env);
    
    // Get current timestamp for deadline validation
    let now = env.ledger().timestamp();
    
    // Attempt to register the task
    let result = client.try_register_task(
        &user,
        &task_type,
        &calldata,
        &reward,
        &deadline,
        &ttl_ledgers,
        &lock_ledgers,
        &None,
    );
    
    match result {
        Ok(task_id) => {
            // Registration succeeded - verify all properties
            
            // 1. Contract should not have panicked (we reached here)
            
            // 2. Task should exist and be readable
            let task = client.try_get_task(&task_id);
            assert!(task.is_ok(), "Successfully registered task should be readable");
            let task = task.unwrap();
            
            // 3. Task should be in Pending state
            assert_eq!(task.status, TaskStatus::Pending, "New task should be Pending");
            
            // 4. Task fields should match what was registered
            assert_eq!(task.owner, user, "Task owner should match");
            assert_eq!(task.task_type, task_type, "Task type should match");
            
            // Calldata equality check (handles empty/short comparisons)
            let registered_calldata = task.calldata.to_vec();
            let input_calldata = calldata.to_vec();
            assert_eq!(
                registered_calldata, input_calldata,
                "Calldata should be stored exactly"
            );
            
            assert_eq!(task.reward, reward, "Task reward should match");
            assert_eq!(task.deadline, deadline, "Task deadline should match");
            assert_eq!(task.ttl_ledgers, ttl_ledgers, "Task TTL should match");
            assert_eq!(task.lock_ledgers, lock_ledgers, "Task lock period should match");
            
            // 5. No claimer should be set for Pending task
            assert!(task.claimer.is_none(), "Pending task should have no claimer");
            assert!(task.claim_ledger.is_none(), "Pending task should have no claim ledger");
            
            // 6. Task should have positive reward (contract enforces this)
            assert!(task.reward > 0, "Registered task should have positive reward");
            
            // 7. Deadline should be in the future (contract enforces this)
            assert!(task.deadline > now, "Registered task deadline should be in future");
            
            // 8. Calldata length should be within limits (contract enforces this)
            assert!(
                calldata.len() <= MAX_CALLDATA_LEN as usize,
                "Registered task calldata should be within limit"
            );
            
            // 9. Verify storage consistency by reading again
            let task_again = client.try_get_task(&task_id).unwrap();
            assert_eq!(task.reward, task_again.reward, "Task should be idempotently readable");
            
            // 10. Task counter should have increased
            let task_count = client.task_count();
            assert!(task_count > 0, "Task count should increase after registration");
        }
        Err(err) => {
            // Registration failed - verify it was a typed KeeperError
            
            // 1. Should be a KeeperError variant
            assert!(
                matches!(
                    err,
                    KeeperError::InvalidReward
                        | KeeperError::DeadlinePassed
                        | KeeperError::CalldataTooLarge
                ),
                "Registration rejection should be a typed KeeperError, got: {:?}",
                err
            );
            
            // 2. Verify the rejection reason matches contract logic
            match err {
                KeeperError::InvalidReward => {
                    // Contract rejects reward <= 0
                    assert!(
                        reward <= 0,
                        "InvalidReward should only occur for non-positive reward"
                    );
                }
                KeeperError::DeadlinePassed => {
                    // Contract rejects deadline <= now
                    assert!(
                        deadline <= now,
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
                    // Unexpected error - this should never happen for register_task
                    panic!("Unexpected KeeperError for register_task: {:?}", err);
                }
            }
            
            // 3. No side effects should occur on rejection
            // (Hard to verify without specific test setup, but contract should be unchanged)
        }
    }
    
    // Final property: contract should never panic for any input
    // If we reach here without panic, the property holds
});
