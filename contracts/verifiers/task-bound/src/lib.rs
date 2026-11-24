//! Worked example verifier for `docs/WRITING_A_VERIFIER.md`.
//!
//! A proof is valid only when it is exactly `b"done:"` followed by the task id
//! as 8 big-endian bytes. Binding the proof to the task id means a proof for
//! one task cannot be replayed on another.
#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

const PREFIX: &[u8] = b"done:";

#[contract]
pub struct TaskBoundVerifier;

#[contractimpl]
impl TaskBoundVerifier {
    /// Called by `KeeperRegistry::execute_task`. Return `false` for a bad proof;
    /// never panic on merely invalid input.
    pub fn verify(env: Env, task_id: u64, _keeper: Address, proof: Bytes) -> bool {
        let mut expected = Bytes::from_slice(&env, PREFIX);
        expected.extend_from_array(&task_id.to_be_bytes());
        proof == expected
    }
}

#[cfg(test)]
mod test;
