# Task Conditions Design and E10 Retrospective

**Status:** implemented in keeper-registry VERSION 6.

## 1. Purpose

A task may name an optional contract that decides whether the task is ready to
be claimed. This gate runs before claim state is written. It is distinct from
the optional verifier: a condition gates `claim_task` before work starts, while
a verifier gates `execute_task` after a keeper submits proof.

An unconditional task stores `condition: None` and follows the original claim
path. A conditioned task stores `Some(address)` in its immutable task record.
Both `register_task` and each `BatchTaskParams` entry accept the same optional
field.

## 2. Interface

Condition contracts implement this exact interface:

```rust
pub trait ITaskCondition {
    fn is_met(env: Env, task_id: u64) -> bool;
}
```

The registry supplies only the task id. It does not supply the prospective
keeper, proof, or arbitrary caller data, so the result is uniform for every
keeper evaluating the same on-chain state. Conditions can use the task id to
look up configuration in their own storage.

Condition addresses are permissionless. Registration does not invoke the
address, maintain an allowlist, or claim that the contract is trustworthy.
This keeps registration bounded and prevents an untrusted callback from moving
funds during escrow creation.

## 3. Claim semantics

For a conditioned task, `claim_task` performs its ordinary lifecycle,
deadline, reputation, and stake checks, then calls `is_met(task_id)` before
changing the task's claimer or claim ledger.

- `true`: claim processing continues.
- `false`: the call returns `KeeperError::ConditionNotMet`.
- missing contract, malformed response, error, or panic: the call fails closed
  as `KeeperError::ConditionNotMet`.

Rejected evaluation emits `ConditionNotMet` with topics
`("condfail", "task")` and data `(task_id, condition)`. The task remains
`Pending` with no claimer, and no escrow moves. `is_claimable` applies the same
condition check and returns `false` for every rejected or failed evaluation.

Keepers pay the resources for the nested condition invocation and should
simulate before submitting. The registry does not impose a separate subcall
budget beyond Soroban transaction limits.

## 4. Registration, storage, and events

VERSION 6 changes these public shapes:

- `register_task(..., verifier, condition)` adds `condition: Option<Address>`.
- `Task` stores `condition: Option<Address>`.
- `BatchTaskParams` stores `condition: Option<Address>`.
- `TaskRegistered` data becomes
  `(task_id, owner, reward, deadline, condition)`.
- error code 40 is `ConditionNotMet`.

Single and batch registration both call `validate_task_params`, including the
condition field, so policy cannot diverge. A batch may mix `Some(address)` and
`None`; a test reads each resulting task and checks the stored value. The
indexer accepts both VERSION 6 registration events and historical four-field
events, which are represented with `condition: null`.

Because the stored `Task` contract type changed, VERSION 6 is a compatibility
boundary. Deployments must follow the repository's reviewed upgrade/migration
process rather than silently interpreting an older task record as the new
shape.

## 5. Security properties

The implementation guarantees that a rejected condition cannot write registry
claim state, move escrow, or emit `TaskClaimed`. It does not guarantee that a
permissionless condition is economically honest, available, side-effect-free,
or cheap. Owners and keepers must assess the selected contract.

The detailed review is in
[`TASK_CONDITIONS_SECURITY_REVIEW.md`](TASK_CONDITIONS_SECURITY_REVIEW.md).
Tests cover approving, rejecting, missing, and panicking condition contracts,
plus unchanged task state after rejection.

## 6. E10 retrospective

### Shipped against the design

- Optional per-task conditions on single and batch registration.
- Fail-closed evaluation before any claim-state mutation.
- A typed error and indexed rejection event.
- Read-only claimability using the same predicate.
- Mixed-batch persistence tests and adversarial failure tests.
- Indexer migration, event parser, REST representation, OpenAPI schema, and
  historical-event compatibility.

### Divergences and rationale

- The final callback receives only `task_id`; it does not receive the keeper.
  This prevents a task owner from selectively approving individual keepers and
  makes preflight results stable across callers.
- Callback errors and panics are normalized to `ConditionNotMet` rather than
  exposing condition-specific errors. This preserves a small registry ABI and
  avoids coupling it to arbitrary contracts.
- `TaskRegistered` was expanded rather than adding a second attachment event.
  A registration event is then a complete source for the task's immutable
  condition, while the indexer retains explicit four-field compatibility.
- Batch parity shipped as the closing E10 follow-up so batched tasks cannot
  silently lose a condition configured on the single-task path.

### Security review outcome

The review accepted a permissionless, owner-selected condition boundary. The
registry isolates false, missing, and panicking callbacks by failing closed and
writing no claim state first. The accepted tradeoffs are that the submitting
keeper pays callback resources, a malicious or unavailable condition can delay
claims until cancellation or expiry, and a condition may mutate its own state
within the outer invocation. No condition receives keeper identity from the
registry ABI.

### Deferred items

- Registry-managed condition allowlists or endorsements.
- Mutable condition replacement on an existing task.
- Composite AND/OR condition contracts.
- A registry-specific nested-call resource budget.
- Keeper-side preflight optimization beyond normal simulation.
- Reference oracle condition implementations; E11 is specified separately in
  [`ORACLE_DESIGN.md`](ORACLE_DESIGN.md).
- In-place migration tooling for deployed pre-VERSION-6 task records.
