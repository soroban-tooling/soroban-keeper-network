# Hash-Preimage Verifier Example

A minimal on-chain proof verifier implementing the `IKeeperVerifier` interface from [`docs/VERIFIER_DESIGN.md`](../../docs/VERIFIER_DESIGN.md).

## Overview

When registering an automated task on Soroban Keeper Network, task owners can optionally attach an on-chain verifier address (`verifier: Option<Address>`). When a keeper submits an execution proof via `execute_task(keeper, task_id, proof)`, the registry invokes `IKeeperVerifier::verify` before transferring the bounty reward.

This example requires that `proof` is the exact SHA-256 preimage of a 32-byte digest registered for that task ID.

## Interface

```rust
#[contractclient(name = "KeeperVerifierClient")]
pub trait IKeeperVerifier {
    /// Returns `true` if `proof` is a valid witness that `keeper` correctly
    /// executed `task_id`'s off-chain work, `false` otherwise.
    fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool;
}
```

## Failure Semantics

1. **Empty Proof**: Returns `false`.
2. **Hash Mismatch**: Returns `false` without panicking.
3. **Unconfigured Task**: Returns `false` without panicking.
4. **Valid Preimage**: Returns `true`, allowing `execute_task` to succeed and release keeper rewards.

## Running Tests

### TypeScript
```bash
npm test --prefix examples/verifiers/hash-preimage
```

### Rust
```bash
cargo test --manifest-path examples/verifiers/hash-preimage/contracts/Cargo.toml
```
