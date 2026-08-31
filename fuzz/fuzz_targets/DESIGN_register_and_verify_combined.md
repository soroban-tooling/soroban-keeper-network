# Design: register_and_verify_combined Fuzz Target

## Overview

This document specifies the design of the `register_and_verify_combined.rs` fuzz target, which will exercise the interaction between parameter validation bounds (from issue 0064) and the verifier path (from issue 0074) together. This is issue #206.

**Status**: Design-phase documentation. Implementation pending merge of issue 0074 (verifier path implementation).

---

## Dependencies

This fuzz target depends on:
- **Issue 0064** (parameter validation bounds fuzzing) - ✅ MERGED
- **Issue 0073** (add `verifier: Option<Address>` parameter to `register_task`) - ⏳ NOT YET MERGED
- **Issue 0074** (verifier call in `execute_task` before reward crediting) - ⏳ NOT YET MERGED
- **Issue 0075** (verifier failure handling policy) - ⏳ NOT YET MERGED

Until 0073 and 0074 are merged:
- The `Task` struct will not have a `verifier` field
- `register_task` will not accept a verifier parameter
- `execute_task` will not invoke any verifier

**Implementation can begin once 0073, 0074, and 0075 are all merged to main.**

---

## Input Generation Strategy

### Dimensions

The fuzz target will generate inputs across three orthogonal dimensions:

1. **Parameter Bounds** (from issue 0064):
   - `reward`: full i128 domain (covers MIN, MAX, zero, negative, positive, boundaries)
   - `deadline`: full u64 domain
   - `ttl_ledgers`: full u32 domain (with focus on MIN_TTL_LEDGERS, MAX_TTL, boundary values)
   - `lock_ledgers`: full u32 domain (with focus on MIN_LOCK_LEDGERS, MAX_LOCK_LEDGERS, boundaries)
   - `calldata`: arbitrary Bytes (empty, small, medium, large, oversized)

2. **Verifier Attachment** (from issue 0074):
   - `verifier: Option<Address>` (None, or a fuzzed address)
   - When present: fuzzed to use either:
     - A deployed mock verifier contract (always-approve)
     - A deployed mock verifier contract (always-reject)
     - A non-existent address (will fail on invoke)
     - An invalid address (e.g., zero address)

3. **Verifier Response** (execution-time behavior):
   - When `execute_task` is called, the verifier's behavior is controlled by fuzz input:
     - Returns `true` (success path)
     - Returns `false` (failure path)
     - Panics (panic-isolation path - should not abort transaction)
     - Host error (contract error - should not abort transaction)

### Input Structure

```rust
#[derive(Arbitrary, Debug)]
struct RegisterAndVerifyCombinedInput {
    // Parameter bounds dimension (from register_task)
    reward_bytes: [u8; 16],      // i128
    deadline_bytes: [u8; 8],     // u64
    ttl_ledgers_bytes: [u8; 4],  // u32
    lock_ledgers_bytes: [u8; 4], // u32
    calldata: Vec<u8>,
    task_type_discriminator: u8,
    
    // Verifier dimension (from issue 0074)
    verifier_selector: u8,        // Controls: None, mock-approve, mock-reject, invalid
    verifier_response_selector: u8, // Controls: true, false, panic, error
    
    // Execution dimension
    proof_content: Vec<u8>,
    proof_len_selector: u8,       // Weights toward MAX_PROOF_LEN boundary
}
```

### Coverage Strategy

Rather than exhaustively enumerate all combinations (which is intractable), the fuzz target will:

1. **Boundary Value Weighting**:
   - For `lock_ledgers`: explicitly weight toward MIN_LOCK_LEDGERS, MAX_LOCK_LEDGERS, and boundary transitions
   - For `ttl_ledgers`: explicitly weight toward MIN_TTL_LEDGERS, MAX_TTL, boundary transitions
   - For `calldata`: weight toward empty, small, MAX_CALLDATA_LEN-1, MAX_CALLDATA_LEN, MAX_CALLDATA_LEN+1
   - For `reward`: weight toward 0, 1, MAX_REWARD, negative transitions
   - For `deadline`: weight toward now, now+1, far future, past

2. **Cross-Product Sampling**:
   - Verifier present × parameter rejected at registration → should see zero escrow movement
   - Verifier present × registration succeeds → should see escrow movement only after execution
   - Verifier rejects at execution → should see zero keeper credit (but also zero escrow release)
   - Verifier panics at execution → should see zero escrow movement (panic-isolation)

3. **Libfuzzer Corpus Seeding**:
   - Seed with explicit combinations:
     - (ttl=MIN, lock=MIN, verifier=None, reward=valid, deadline=valid) → should succeed
     - (ttl=MIN-1, lock=MIN, verifier=None, ...) → should reject at registration
     - (ttl=MIN, lock=MAX+1, verifier=Some(...), ...) → should reject at registration, verifier never invoked
     - (ttl=MAX, lock=MAX, verifier=Some(approve), ...) → should reach execution and succeed
     - (ttl=MAX, lock=MAX, verifier=Some(reject), ...) → should reach execution and reject

---

## Assertion Strategy

### Per-Registration Success

When `register_task` succeeds (with or without verifier):

1. **No Panic**: Reached here without abort → property holds
2. **Task Exists**: `get_task(task_id)` returns the registered task
3. **Status is Pending**: Task is in `Pending` state
4. **Escrow Moved**: Token balance decreased by reward amount, or keeper_balance not yet credited
5. **Field Match**: All fields match input (type, calldata, reward, deadline, ttl, lock, verifier)
6. **Claimer None**: No claimer set for `Pending` task
7. **Idempotent Read**: Reading again returns same task

### Per-Registration Rejection

When `register_task` fails (parameter validation rejection, before verifier is ever touched):

1. **Typed Error**: Returns a `KeeperError` variant matching the validation rule:
   - `InvalidReward` → reward ≤ 0
   - `DeadlinePassed` → deadline ≤ now
   - `CalldataTooLarge` → calldata.len() > MAX_CALLDATA_LEN
   - `InvalidTaskParams` → ttl or lock out of bounds

2. **Zero Escrow Movement**: 
   - Token balance unchanged
   - Keeper balance unchanged
   - Fees accrued unchanged
   - No `TaskRegistered` event emitted
   - **This must hold regardless of verifier attachment** — a bad parameter should reject before the verifier is even consulted

3. **No Side Effects**: 
   - Task counter unchanged
   - No partial state created

### Per-Execution Success (Verifier Approved)

When `claim` → `execute` succeeds (verifier present and returns `true`, or absent):

1. **Verifier Not Invoked If Absent**: For tasks with `verifier: None`, execution proceeds immediately to crediting
2. **Verifier Invoked If Present**: For tasks with `verifier: Some(addr)`, verify it was called via `try_invoke_contract` with:
   - Correct task_id
   - Correct keeper address
   - Immutable proof (by reference, not capability)
3. **Reward Split**: I-4 (fee bounding) holds:
   - `keeper_net + fee == reward`
   - `fee == floor(reward * fee_bps / 10_000)`
   - `keeper_net == reward - fee`
4. **Keeper Credited**: `keeper_balance` increases by exactly `keeper_net`
5. **Fees Accrued**: `fees_accrued` increases by exactly `fee`
6. **Task Status Updated**: Task now in `Executed` state
7. **Event Emitted**: `TaskExecuted` event with proof, keeper, net reward
8. **I-1 Solvency**: Total contract balance = Σ task escrow + Σ keeper balances + fees_accrued

### Per-Execution Rejection (Verifier Denied or Failed)

When `claim` → `execute` fails (verifier present and returns `false`, or panics):

1. **Execution Rejected**: Call returns `VerificationFailed` (or typed error matching the verifier's rejection)
2. **Zero State Change**:
   - Keeper balance unchanged (no credit)
   - Fees accrued unchanged (no fee movement)
   - Task status still `Claimed` (not `Executed`)
   - No `TaskExecuted` event emitted
3. **Claim Still Active**: Keeper can retry with different proof
4. **Retry Path**: Lock period still unexpired, so task remains claimable by same keeper

### Per-Verifier-Panic (Panic Isolation)

When verifier panics during `execute_task`:

1. **No Transaction Abort**: Verifier panic is caught by `try_invoke_contract`, transaction completes
2. **Execution Rejected**: Call returns typed error (same as verifier returned `false`)
3. **Zero State Change**: Same as "verifier denied" case above
4. **I-8 Invariant Holds**: Verifier panic did not allow any capability leakage (keeper credit still zero, escrow untouched)

---

## Invariants Checked

### Always Checked

- **I-1 (Solvency)**: After every operation, contract_balance = escrow + keeper_balances + fees_accrued
- **I-3 (Single Payout)**: Each task's reward appears exactly once across (keeper credit + fee)
- **I-4 (Fee Bounding)**: Fee never exceeds `fee_bps` of reward
- **I-7 (Monotonic IDs)**: Task IDs strictly increase, never reused
- **I-8 (Verifier Trust Boundary)**: 
  - Verifier receives immutable parameters only (no capability to credit or transfer)
  - Verifier call happens before any state mutation
  - Verifier return value only gates an if-branch, not stored in task state
  - Verifier panic/rejection prevents state mutation but doesn't abort transaction

### Conditionally Checked

- **I-2 (Escrow Recoverability)**: If tested with expiry/cancellation, all escrowed rewards must be recoverable
- **I-5 (Escrow Isolation)**: If admin functions invoked, they don't touch escrow or keeper balances
- **I-6 (Withdrawal Liveness)**: If tested, keeper balance always withdrawable

---

## Mock Verifier Contracts

To fuzz the verifier interaction without depending on a real verifier implementation, the fuzz target will define two simple in-process mock verifier contracts:

### Mock Always-Approve Verifier

```rust
// Pseudo-code representation
pub fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool {
    // Always return true
    true
}
```

Fuzz behavior:
- Registered task with this verifier will always pass execution (if proof is valid)

### Mock Always-Reject Verifier

```rust
// Pseudo-code representation
pub fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool {
    // Always return false
    false
}
```

Fuzz behavior:
- Registered task with this verifier will always fail execution

### Mock Panicking Verifier

```rust
// Pseudo-code representation
pub fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool {
    // Panic to test panic isolation
    panic!("simulated verifier panic");
}
```

Fuzz behavior:
- Registered task with this verifier will trigger panic during execution
- Panic should be caught, execution should fail, state unchanged

---

## Implementation Notes

### Reuse Existing Patterns

1. **Parameter Interpretation**: Reuse from `register_task.rs`:
   ```rust
   let reward = i128::from_le_bytes(reward_bytes);
   let deadline = u64::from_le_bytes(deadline_bytes);
   // ... etc
   ```

2. **Boundary Weighting**: Reuse from `execute_task.rs`:
   ```rust
   fn lock_ledgers_for(selector: u8) -> u32 {
       match selector % 5 {
           0 => MIN_LOCK_LEDGERS.saturating_sub(1),
           1 => MIN_LOCK_LEDGERS,
           2 => MAX_LOCK_LEDGERS,
           3 => MAX_LOCK_LEDGERS.saturating_add(1),
           _ => (selector as u32) % (MAX_LOCK_LEDGERS + 1),
       }
   }
   ```

3. **Invariant Assertions**: Reuse from `keeper_registry::invariants`:
   ```rust
   assert_fee_bounded(reward, fee_bps, keeper_net, fee)?;
   assert_solvent(...)?;
   ```

### Harness Setup

- Use `RegistryHarness::new()` for deterministic initialization
- Deploy mock verifier contracts at harness creation time
- Store verifier addresses in harness for reuse across fuzz runs

### State Inspection

- Use `keeper_balance(keeper)` to check keeper credit
- Use `fees_accrued()` to check accumulated fees
- Use `get_task(task_id)` to check task state and status
- Inspect events via `env.events()` for emitted proofs and event ordering

---

## Expected Outcomes

When this fuzz target runs for a sufficient duration (TBD: 1M+ iterations), we expect:

✅ **No panics or host errors**
✅ **All invariants (I-1 through I-8) hold across all generated combinations**
✅ **Zero escrow movement on any parameter-validation rejection, regardless of verifier**
✅ **Correct state transitions for verifier-present vs verifier-absent cases**
✅ **Correct handling of verifier rejection and panic isolation**

If any invariant is violated or a panic occurs, the fuzz target will:
1. Report the minimal reproducer (the seed input that triggered it)
2. Identify which assertion failed (and which invariant was broken)
3. Suggest the likely root cause based on the invariant (e.g., "I-1 solvency violated suggests token balance not updated correctly")

---

## Timeline

- **Design Phase (Current)**: ✅ Complete
- **Blocked**: Awaiting merge of issues 0073, 0074, 0075 to add verifier feature
- **Implementation Phase**: Can begin once 0073/0074/0075 are merged
- **Testing Phase**: Run fuzz target for documented duration (e.g., 8 hours, 10M iterations)
- **Reporting**: Commit, create PR referencing #206, document findings and run duration

---

## References

- **Issue #206**: `test(fuzz): fuzz parameter-validation bounds and verifier path together`
- **Issue #0064**: Parameter validation bounds fuzzing (MERGED)
- **Issue #0074**: Verifier call in execute_task (NOT YET MERGED)
- **Issue #0132**: I-8 invariant documentation (merged with I-8 already in ARCHITECTURE.md)
- **Existing Fuzz Targets**:
  - `fuzz/fuzz_targets/register_task.rs` — parameter bounds
  - `fuzz/fuzz_targets/execute_task.rs` — proof handling and fee bounding
- **Infrastructure**:
  - `fuzz/src/support.rs` — RegistryHarness and helpers
  - `contracts/keeper-registry/src/invariants.rs` — shared assertion functions
