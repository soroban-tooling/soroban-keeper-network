//! The `IKeeperVerifier` interface external verifier contracts implement.
//!
//! Design rationale, failure semantics, and trust model: `docs/VERIFIER_DESIGN.md`.

use soroban_sdk::{contractclient, Address, Bytes, Env};

/// Implemented by any contract a task owner wants to use as a per-task proof
/// verifier, attached via `register_task`'s optional `verifier` parameter.
/// `execute_task` calls this — through the generated `KeeperVerifierClient`'s
/// `try_verify`, which catches a callee panic rather than propagating it — before
/// crediting the keeper. See `docs/VERIFIER_DESIGN.md` §1-2.
#[contractclient(name = "KeeperVerifierClient")]
pub trait IKeeperVerifier {
    /// Returns `true` if `proof` is a valid witness that `keeper` correctly
    /// executed `task_id`'s off-chain work, `false` otherwise.
    ///
    /// Must not panic on a merely-invalid proof — return `false`. A panic is
    /// reserved for the verifier being fundamentally broken, and
    /// `execute_task` treats it as equivalent to `false` regardless.
    fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool;
}
