# Epic E10: On-Chain Task Conditions Architecture

**Date**: October 2026  
**Status**: Design (pre-implementation)  
**Related Epics**: E04 (Verifier Design, shipped), E06 (Reputation System, shipped)

---

## Executive Summary

This document designs an **on-chain task condition** system that gates `claim_task`, checking whether a task is worth attempting before any off-chain work happens. Unlike the E04 verifier (which validates proof *after* execution), a condition checks whether the underlying off-chain event the task reacts to is actually true *before* claiming.

This is a **new mechanism**, distinct from E04 and orthogonal to it. Both will coexist:
- **Task Condition** (E10, this epic): `claim_task` gate. Answer: "Is the task even worth attempting?"
- **Proof Verifier** (E04, shipped): `execute_task` gate. Answer: "Did the keeper prove the work was done correctly?"

---

## Questions and Decisions

### Q1: Relationship to E04 Verifier Epic

**Question**: E04 designed an on-chain verification callback for `execute_task`, never implemented. Does E10's condition check reuse E04's design decisions, or start fresh?

**Decision**: **E10 and E04 are distinct, non-overlapping mechanisms. E10 starts fresh.**

**Rationale**:
- **E04 verifier** is an `execute_task` gate checking **proof of work** after the fact. It answers: "Did the keeper prove they executed the task correctly?" (binary: reject retryable/accept with settlement).
- **E10 condition** is a `claim_task` gate checking **off-chain event state** proactively. It answers: "Is the task's trigger condition actually true right now?" (binary: reject and remain Pending/accept and move to Claimed).
- **Different timing**: Verifier runs *after* claimed keeper does work; condition runs *before* any keeper commits.
- **Different contract flows**: Verifier is an optional proof validator; condition is an optional event-state checker.
- **Different interfaces**: They need different return semantics and failure handling (condition has no proof argument; verifier is tied to proof submission).

**E04 Reusable Elements** (optional, implementation decision):
- E04 used `try_invoke_contract` to catch panics (safe but verbose). E10 can adopt or simplify.
- E04's permissionless design (any address can be verifier) applies to conditions too: no curated allow-list in core.

**E04 Non-Reusable Elements**:
- E04's `IKeeperVerifier` trait signature (proof parameter) does not fit conditions.
- E04's "stays Claimed on rejection" does not fit conditions (which must reject before Claimed is set).
- E04's issue 0076 (gas budget for verifier calls) still unresolved and applies equally here; see Q4.

**Conclusion**: E10's condition interface and semantics are independently designed. Both mechanisms are shipped in the same registry contract version; keepers must simulate *both* before claiming if both are present on a task.

---

### Q2: Predicate Interface

**Question**: What is the exact interface for a task condition?

**Decision**: A condition is a **cross-contract call to a task-specified address**. The interface is:

```rust
pub trait IKeeperCondition {
    fn is_condition_met(env: Env, task_id: u64) -> bool;
}
```

**Rationale**:

1. **Signature**: `(task_id: u64) -> bool`
   - Takes only `task_id` (unlike verifier's `task_id, keeper, proof`).
   - Returns plain bool: true = condition met, claim allowed; false = condition not met, reject.
   - No proof argument: the condition checker is responsible for proof if needed (e.g., oracle verifier fetches price on-chain; it's the verifier's burden, not the keeper's).

2. **Why task_id and not task object?**
   - Condition checker can load the task itself via the registry if needed (contract is in-chain).
   - task_id suffices to uniquely identify the task and its parameters (calldata, deadline, owner, etc.).
   - Keeps interface minimal and immutable.

3. **No keeper parameter?**
   - Unlike verifier (which binds proof to keeper to prevent replay), condition is *keeper-independent*.
   - Condition asks: "Is the market condition true?" not "Is this keeper's proof valid?"
   - Different keepers can independently verify the same condition is true; no keeper-binding needed.

4. **Single-step evaluation, no retry semantics**:
   - Condition returns bool. No partial/staged result or "try later" distinction.
   - If condition is false, task stays Pending; keeper may retry later if condition becomes true.
   - No gradation like verifier's "proof invalid but retryable" vs. "proof rejected final."

**Comparison to E04 Verifier**:
| Aspect | E04 Verifier | E10 Condition |
| --- | --- | --- |
| Trait name | `IKeeperVerifier` | `IKeeperCondition` |
| Signature | `verify(task_id, keeper, proof) -> bool` | `is_condition_met(task_id) -> bool` |
| Gate | `execute_task` (after claim) | `claim_task` (before claim) |
| Question | "Is keeper's proof valid?" | "Is the off-chain event true?" |
| Keeper parameter | Yes (proof binding) | No (event-independent) |
| Proof parameter | Yes | No |
| Failure semantics | Task stays Claimed (retryable) | Task stays Pending (can retry) |
| On panic | Treated as false | Treated as false |

---

### Q3: What Happens on a False Condition

**Question**: When `is_condition_met` returns false or panics, what happens to the task?

**Options**:
- **(A) Reject and remain Pending** (almost certainly correct)
- (B) Reject and mark as Expired/Terminal
- (C) Defer with error code (task knows it was attempted)

**Decision**: **(A) Reject and remain Pending. Task is left exactly as if no one had attempted to claim it.**

**Rationale**:

1. **Consistency with existing design**:
   - E04 verifier rejection leaves task `Claimed` (retryable, different keeper can reattempt).
   - Condition failure is *prior* to claim, so task stays `Pending` (symmetric: no claim was ever recorded).
   - No state is corrupted; next keeper's `claim_task` sees identical task state.

2. **Retry semantics**:
   - Condition false = task not worth attempting *right now*.
   - Condition may become true later (price crosses threshold, position becomes liquidatable).
   - Leaving task Pending allows future retry without manual admin intervention.

3. **No griefing path**:
   - Condition is read-only, no side effects (unlike a verifier proof which must be submitted).
   - Attacker cannot DOS the task by repeating false conditions; first false = immediate rejection (same as if keeper never tried).

4. **Event emission**:
   - `claim_task` will emit `TaskClaimed` on successful claim (current behavior).
   - On condition failure, `claim_task` rejects without state change; no event needed (task state unchanged, so no log entry needed to track failure).
   - Keeper can log the failure client-side for monitoring.

**Conclusion**: Task remains `Pending` and fully retryable. No record of the failed claim attempt is kept on-chain (to avoid bloat and log spam).

---

### Q4: Gas and Resource Cost

**Question**: Who pays for the condition check cross-contract call?

**Options**:
- **(A) Claiming keeper pays** (full cost)
- (B) Task owner escrows condition budget
- (C) Protocol absorbs it (fee_bps raised)

**Decision**: **(A) Claiming keeper pays the full cost of the condition check.**

**Rationale**:

1. **Consistency with E04 verifier**:
   - E04 issue 0076 (cost allocation for verifier) never resolved because E04 wasn't shipped.
   - Setting precedent now: keeper pays their own transaction cost, including any sub-calls.
   - Keeper chooses to claim a task; keeper bears cost.

2. **Incentive alignment**:
   - Keeper simulates condition locally (via `simulateTransaction`) before on-chain attempt.
   - If condition is expensive, keeper decides task is not profitable after gas cost; doesn't claim.
   - Permissionless condition design: any address can be a condition (malicious expensive logic is keeper's risk to avoid).

3. **No sub-call budget in Soroban**:
   - Soroban's `Env::invoke_contract` and `Env::try_invoke_contract` do not support per-call gas limits (unlike Ethereum's `call{gas: g}()`).
   - If condition exceeds transaction budget, entire `claim_task` fails (host budget exhaustion).
   - Keeper must estimate or simulate to avoid overruns; cost budgeting happens off-chain.

4. **Backward compatibility**:
   - Tasks without condition incur zero condition cost (no cross-contract call).
   - Existing tasks unaffected.

**Task Owner Responsibilities** (off-chain):
- Task owner should **choose a condition address that is efficient** and returns quickly.
- If owner attaches a pathological condition (expensive, DoS), keepers will refuse to claim (profit margin erodes).
- Market self-corrects: tasks with bad conditions go unclaimed; incentive for owner to fix.

**Protocol Considerations**:
- No protocol fee bump needed; condition cost is external to task execution.
- Task owner could optionally increase `reward` to compensate for expected condition cost (off-chain negotiation/market signal).

**Conclusion**: Keeper pays. Keeper simulates. Market corrects. No special subsidy or budget.

---

### Q5: Backward Compatibility

**Question**: Tasks registered without a condition (the overwhelming majority of existing and near-future tasks) must have zero added cost or behavior change.

**Decision**: **Tasks without a condition (condition field `None`) are treated identically to today.**

**Rationale**:

1. **Storage field is optional**:
   - Task struct gains a new field: `condition: Option<Address>`.
   - Migration: all existing tasks have `None` (no condition set).
   - Future tasks can set it at registration; existing tasks unaffected.

2. **No runtime cost**:
   - In `claim_task`, check `if task.condition.is_some()` before cross-contract call.
   - If `None`, skip condition check entirely (zero cost).
   - If `Some(addr)`, invoke condition as described above.

3. **Update semantics**:
   - Like `verifier`, condition can be updated by owner while task is `Pending` (lines in E04's `update_verifier` logic apply here too).
   - Once claimed, condition is immutable (no mid-execution surprises).

4. **No fee impact**:
   - Condition cost is not included in `fee_bps` calculation (condition is keeper-paid, not from reward).
   - Existing fee structure unchanged.

5. **Initialization**:
   - `register_task` gains new optional parameter: `condition: Option<Address>`.
   - Backward compatibility: old contract calls without condition parameter must still work (language bindings default to `None` or caller explicitly passes `None`).

**Example Timeline**:
- **Today**: All existing tasks have `condition: None`. `claim_task` skips condition check. Zero overhead.
- **Post-E10 ship**: New tasks can optionally include a condition address. Old tasks still have `None`, still skip check.
- **5 years later**: Ecosystem may adopt conditions widely, but each task's cost/behavior is independent; no lock-in.

**Conclusion**: Fully backward compatible. No cost, no behavior change for tasks without conditions.

---

## Design Decisions Summary

| Question | Decision | Rationale |
| --- | --- | --- |
| **Q1: E04 Reuse?** | No, start fresh. E10 and E04 are orthogonal. | Different timing (before vs. after claim), interfaces, semantics. |
| **Q2: Interface?** | `is_condition_met(task_id: u64) -> bool` | Minimal, keeper-independent, event-state check. |
| **Q3: False condition?** | Task stays Pending, no state change. | Consistency, retry-friendly, no griefing. |
| **Q4: Who pays?** | Keeper pays full condition cost. | Incentive alignment, simulation-before-claim, permissionless. |
| **Q5: Backward compat?** | Tasks without condition pay zero cost. | Optional field, optional check, no fee impact. |

---

## Implementation Details

### Storage Changes

**Task struct addition** (`types.rs`):
```rust
pub struct Task {
    // ... existing fields ...
    pub verifier: Option<Address>,
    pub condition: Option<Address>,  // NEW: optional on-chain condition checker
}
```

**Rationale**:
- Parallel to `verifier` field (same design pattern).
- Optional: `None` means no condition (backward compat).
- Immutable once claimed (like verifier).

### Entry Point Signature Changes

**register_task** (`task.rs`):
```rust
pub fn register_task(
    e: Env,
    owner: Address,
    reward: i128,
    calldata: Bytes,
    task_type: TaskType,
    deadline: u64,
    lock_ledgers: u32,
    ttl_ledgers: u32,
    verifier: Option<Address>,
    condition: Option<Address>,  // NEW
) -> Result<u64, KeeperError>
```

**Changes**:
- Add `condition: Option<Address>` as final parameter.
- Store in task struct.
- Validate (same as verifier validation; see below).

**Existing entry points affected**:
- `update_condition()` (new): owner can change condition while task is Pending.
  ```rust
  pub fn update_condition(
      e: Env,
      task_id: u64,
      new_condition: Option<Address>,
  ) -> Result<(), KeeperError>
  ```
  - Precondition: task exists and is Pending.
  - Owner must authenticate.
  - Idempotent (can set to same value).

### claim_task Logic Changes

**Updated `claim_task` implementation** (`task.rs`):
```rust
pub fn claim_task(
    e: Env,
    keeper: Address,
    task_id: u64,
) -> Result<(), KeeperError> {
    require_not_paused(&e)?;
    keeper.require_auth();

    let task = load_task(&e, task_id)?;
    require_deadline_not_passed(&e, &task)?;
    require_claimable(&e, &task)?;
    require_min_stake(&e, &keeper)?;
    require_reputation_floor(&e, &keeper)?;

    // NEW: check condition if present
    if let Some(condition_addr) = &task.condition {
        let condition_met = invoke_condition(&e, &condition_addr, task_id)?;
        if !condition_met {
            return Err(KeeperError::ConditionNotMet);
        }
    }

    // Existing mutation logic
    record_missed_claim_if_reclaim(&e, &task)?;
    let mut task = task;
    task.status = TaskStatus::Claimed;
    task.claimer = Some(keeper.clone());
    task.claim_ledger = Some(e.ledger().sequence());

    save_task(&e, task_id, &task);
    bump_instance(&e);
    emit_task_claimed(&e, task_id, &keeper);

    Ok(())
}
```

**New helper** (`task.rs`):
```rust
fn invoke_condition(
    e: &Env,
    condition_addr: &Address,
    task_id: u64,
) -> Result<bool, KeeperError> {
    let condition = IKeeperConditionClient::new(e, condition_addr);
    let result = condition.try_is_condition_met(&task_id);
    match result {
        Ok(Ok(bool_val)) => Ok(bool_val),
        Ok(Err(_)) => Ok(false),  // Condition reverted; treat as not met
        Err(_) => Err(KeeperError::ConditionInvocationFailed),  // Host error
    }
}
```

**Error handling**:
- **Condition returns false**: Reject claim, return `KeeperError::ConditionNotMet`.
- **Condition panics/reverts**: Treat as false (via `try_is_condition_met`), reject claim.
- **Host error (e.g., condition contract doesn't exist)**: Return `KeeperError::ConditionInvocationFailed` (hard error).

**Insertion point in flow**:
- Condition check happens *after* reputation/stake checks and *before* state mutations.
- Rationale: cost-effective ordering (cheap permission checks first, then condition which may be expensive).

### Event Changes

**New event** (`events.rs`):
```rust
pub fn emit_condition_not_met(e: &Env, task_id: u64, condition_addr: &Address) {
    let topics = (Symbol::new(&e, "condition_not_met"), task_id);
    e.events().publish(topics, condition_addr);
}
```

**When emitted**: If condition check fails (but no state change, so optional for logging). Can be omitted for simplicity; keeper monitors `claim_task` rejections.

### Error Codes

**New errors in `KeeperError` enum** (`errors.rs`):
```rust
pub enum KeeperError {
    // ... existing ...
    ConditionNotMet,              // Condition evaluated to false
    ConditionInvocationFailed,    // Host error calling condition
}
```

---

## Interface: IKeeperCondition

**Trait definition** (`condition.rs`, new file):
```rust
use soroban_sdk::{Env, contractclient};

#[contractclient(crate = "crate")]
pub trait IKeeperCondition {
    fn is_condition_met(env: Env, task_id: u64) -> bool;
}
```

**Notes**:
- Macro generates `IKeeperConditionClient` for `KeeperRegistryClient` to invoke.
- Same pattern as `IKeeperVerifier` from E04.
- Implementers (condition contracts) inherit responsibility for any proof validation or oracle fetching.

---

## Example Scenarios

### Scenario 1: Price-Based Condition
A liquidation task carries a condition contract that checks if an oracle price is below a liquidation threshold:

1. **Register task**: owner specifies `condition: Some(price_condition_contract)`.
2. **Keeper attempts claim**: `claim_task` invokes `price_condition_contract.is_condition_met(task_id)`.
3. **Price checker**:
   - Loads task via registry (or receives task params off-chain from keeper).
   - Fetches oracle price via Stellar/Soroban oracle.
   - Compares against threshold stored in task params (in `calldata`).
   - Returns `true` if price is below threshold, `false` otherwise.
4. **If true**: keeper claim succeeds, task moves to `Claimed`.
5. **If false**: keeper claim rejected with `ConditionNotMet`, task remains `Pending`.

### Scenario 2: Backward Compat (No Condition)
Existing task from pre-E10 era has `condition: None`:

1. **Keeper attempts claim**: `claim_task` checks `if task.condition.is_some()` → false, skips condition.
2. **No cross-contract call**, zero condition cost.
3. **Claim proceeds normally** (if all other checks pass).

### Scenario 3: Expensive Condition, Keeper Simulates
A condition contract is expensive (e.g., complex oracle aggregation):

1. **Keeper client simulates** `simulateTransaction(claim_task(...))` locally to estimate gas.
2. **Simulation includes condition sub-call** (full gas profile).
3. **Keeper estimates**: Gas cost is 50% of reward → profit margin too thin, doesn't submit.
4. **Keeper skips this task**, seeks more profitable opportunities.

### Scenario 4: Composition (Condition + Verifier)
A task has both `condition` and `verifier`:

1. **Keeper attempts claim**: `claim_task` checks condition first.
2. **If condition false**: claim rejected immediately (no state change).
3. **If condition true**: claim succeeds, task moves to `Claimed`.
4. **Keeper executes**: `execute_task` checks verifier on proof.
5. **If verifier fails**: task stays `Claimed` (retryable).
6. **If verifier passes**: task moves to `Executed`, keeper settled.

---

## Implementation Roadmap

### Phase 1: Core (Epic E10)
- [ ] Add `condition: Option<Address>` field to Task struct.
- [ ] Implement `update_condition()` entry point.
- [ ] Add condition check to `claim_task` (invoke, handle errors, reject on false).
- [ ] Add `ConditionNotMet` and `ConditionInvocationFailed` error codes.
- [ ] Create `condition.rs` with `IKeeperCondition` trait.
- [ ] Tests: unit and integration with mock condition contracts.
- [ ] Documentation: keeper integration guide (simulation, gas estimation).

### Phase 2: Reference Conditions (future epic, outside E10)
- [ ] Reference oracle-price condition (proof of concept).
- [ ] Reference TVL/utilization condition.
- [ ] SDK/binding for common condition patterns.

### Phase 3: Ecosystem (future)
- [ ] Condition aggregators/combinators (AND, OR logic).
- [ ] Condition marketplace/registry (advisory, not enforced in core).

---

## Testing Strategy

### Unit Tests
1. **Condition true**: `claim_task` succeeds.
2. **Condition false**: `claim_task` rejected, task stays Pending.
3. **Condition panics**: Treated as false, task stays Pending.
4. **No condition (None)**: Condition check skipped, claim proceeds normally.
5. **Update condition while Pending**: Succeeds, new condition used on next claim.
6. **Update condition while Claimed**: Fails with InvalidTaskStatus.
7. **Condition invocation error**: Rejected with ConditionInvocationFailed.

### Integration Tests
1. **Task with condition and verifier**: Both gates checked in order.
2. **Repeated attempts**: First false (condition), second true later (reraise via recovery path).
3. **Gas simulation**: Keeper simulates condition gas cost before on-chain attempt.
4. **Backward compat**: Old tasks without condition remain unaffected.

### Mock Condition Contracts
- `MockConditionTrue`: Always returns true (baseline).
- `MockConditionFalse`: Always returns false (rejection path).
- `MockConditionPanic`: Panics (panic handling).
- `MockConditionExpensive`: Simulates high gas usage.

---

## Distinction from E04 (Verifier)

To prevent future confusion, here is the explicit distinction:

| Aspect | E04 Verifier | E10 Condition |
| --- | --- | --- |
| **Purpose** | Validate proof of execution | Gate claim based on event state |
| **When checked** | During `execute_task` (after keeper claims) | During `claim_task` (before keeper claims) |
| **Question asked** | "Did the keeper prove they did the work?" | "Is the underlying event actually true?" |
| **Input** | task_id, keeper, proof | task_id only |
| **Output** | Boolean (pass/fail) | Boolean (condition met/not met) |
| **Failure mode** | Task stays Claimed (retryable by next keeper) | Task stays Pending (can retry later) |
| **On panic/error** | Treated as proof rejected, task stays Claimed | Treated as condition not met, task stays Pending |
| **Keeper submits** | Proof (off-chain data) | Nothing (condition is self-contained) |
| **Use case** | Signature verification, SNARK proofs, attestations | Oracle price checks, state validation, availability gates |
| **Permissionless?** | Yes (any address can be verifier) | Yes (any address can be condition) |
| **Composition possible?** | Verifier aggregators (AND/OR logic) | Condition aggregators (AND/OR logic) |

**Key Insight**: Verifier and condition are **independent predicates** on *different* parts of the task lifecycle. Both will often be present; neither supersedes the other.

---

## FAQs

### FAQ 1: Can a condition re-check mid-execution?
No. Condition is checked once at `claim_task`. If condition becomes false later, task stays `Claimed`. If keeper detects the condition is no longer true, keeper can cancel the task or wait for expiry. No in-execution re-check.

### FAQ 2: What if condition changes after claim?
Condition is immutable once claimed (like verifier). If owner needs to update, owner must cancel/reregister the task. Rationale: prevents griefing (owner cannot suddenly invalidate a claimed task).

### FAQ 3: Can a task have both condition and verifier?
Yes. Condition is checked at claim; verifier is checked at execute. Both gates must pass. Keeper simulates both before claiming.

### FAQ 4: Who is responsible for condition availability?
Task owner. If condition address is deleted/archived, `claim_task` fails with `ConditionInvocationFailed`. Owner should ensure condition contract is well-maintained and has sufficient TTL.

### FAQ 5: Can a condition call back to the registry?
Yes. Condition contract can invoke the registry to fetch task details. This is useful for price conditions that need to compare oracle price against task params stored in `calldata`. No special restrictions; standard cross-contract call pattern.

### FAQ 6: What if condition is very expensive?
Keeper evaluates via `simulateTransaction` before on-chain attempt. If gas cost erodes profit, keeper doesn't claim. Market self-corrects: expensive conditions go unclaimed; owner incentivized to optimize.

### FAQ 7: Is condition state-changing?
No. Condition is a **pure query**. It should have no side effects. If a condition modifies storage, behavior is undefined (Soroban may fail the transaction or allow it; keeper takes the risk). Best practice: condition contracts are read-only.

---

## Acceptance Criteria

- [x] **Q1 answered**: E10 and E04 are distinct, orthogonal mechanisms. Q1 rationale explains why they don't overlap.
- [x] **Q2 answered**: Exact interface specified: `IKeeperCondition::is_condition_met(task_id: u64) -> bool`.
- [x] **Q3 answered**: Explicit decision: task stays Pending on condition false, consistent with registry design.
- [x] **Q4 answered**: Keeper pays full condition cost; simulation-before-claim is keeper's responsibility; no sub-call budget in Soroban.
- [x] **Q5 answered**: Tasks without condition (`None`) incur zero cost, fully backward compatible.
- [x] **Storage changes pinned**: Task struct gains `condition: Option<Address>` field.
- [x] **Entry point changes pinned**: `register_task` gains `condition` parameter; `update_condition()` new entry point; `claim_task` adds condition check.
- [x] **Error codes defined**: `ConditionNotMet`, `ConditionInvocationFailed`.
- [x] **Interface specified**: `IKeeperCondition` trait with `is_condition_met` method.
- [x] **Distinction from E04 clear**: Detailed comparison table and FAQ address confusion risk.

---

## References

- **E04 Verifier Design**: `docs/VERIFIER_DESIGN.md` (shipped, source of truth on proof validation patterns).
- **Issue 0076 (never resolved)**: Gas budgeting for sub-calls (addressed by keeper simulation strategy in E10).
- **Soroban Invoke Docs**: No per-call gas limits; full transaction cost applies.
- **Task Lifecycle**: `contracts/keeper-registry/src/task.rs`, claim_task implementation (foundation for condition check insertion point).

---

## Sign-Off

**Design Lead**: [Chief]  
**Status**: Ready for implementation (all acceptance criteria met)  
**Next Phase**: Epic E10 task decomposition and coding.
