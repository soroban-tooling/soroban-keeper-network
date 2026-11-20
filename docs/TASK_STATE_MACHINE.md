# Task State Machine

Formal specification of the keeper-registry task lifecycle as an explicit
state machine. Every state, every transition, every guard, and every balance
effect is listed in a single place so tests can be written *against this
document* rather than inferred from the source.

The property test `property_no_transition_outside_state_machine_table`
in `contracts/keeper-registry/src/test/property.rs` asserts that every
(from-state, entry-point) pair the fuzzer can reach either (a) matches a row
in the **Transition table** below, or (b) is rejected with the expected
typed error from the **Rejection table** — there is no third option.

---

## States

| State | Description | Funds location |
|---|---|---|
| `Pending` | Task registered and funded; no keeper holds a claim. | Escrowed in the registry contract. |
| `Claimed` | A keeper holds an exclusive execution lock for `lock_ledgers` ledgers. | Still escrowed; lock prevents takeover until the window elapses. |
| `Executed` | Keeper submitted a valid proof; reward split has been applied. | Keeper net reward credited to `KeeperReward(keeper)`; fee in `FeesAccrued`. |
| `Cancelled` | Owner reclaimed escrow before execution. | Returned to `owner` via token transfer (CEI-ordered). |
| `Expired` | Deadline passed without execution; anyone triggered expiry. | Returned to `owner` via token transfer (CEI-ordered). |

`Executed`, `Cancelled`, and `Expired` are **terminal states**. No entry
point transitions out of them. Any attempt to call a mutating entry point
against a terminal-state task returns `KeeperError::InvalidTaskStatus`.

---

## Transition table

Each row is one valid state transition. "Guard" lists every condition that
must hold for the transition to succeed; a guard failure returns the typed
error named in the **Rejection table** instead.

> **Balance effects notation**
> - `escrow(task)` — the token amount locked in the registry for this task
>   (equals `task.reward`).
> - `KeeperReward(k)` — keeper `k`'s credited withdrawable balance.
> - `FeesAccrued` — the protocol fee accumulator.
> - `→` — set to, `+=` — add to, `-=` subtract from.

| # | Entry point | From | To | Guards | Balance effects | Event emitted |
|---|---|---|---|---|---|---|
| T-1 | `register_task` | *(none)* | `Pending` | Contract not paused; `reward > 0`; `reward >= min_reward`; `deadline > now`; `calldata.len() <= MAX_CALLDATA_LEN`; `MIN_LOCK_LEDGERS <= lock_ledgers <= MAX_LOCK_LEDGERS`; `ttl_ledgers >= MIN_TTL_LEDGERS`; `ttl_ledgers >= required_ttl_ledgers(deadline)`. Owner must auth. | `escrow(task) = reward` (transferred from `owner`). | `TaskRegistered` |
| T-2 | `claim_task` | `Pending` | `Claimed` | Contract not paused; `now < task.deadline`; keeper's stake ≥ `MinStake` (if set); keeper's stored reputation ≥ `ReputationFloor` (if set). Keeper must auth. | None. | `TaskClaimed` |
| T-3 | `claim_task` | `Claimed` | `Claimed` | Contract not paused; `now < task.deadline`; previous lock expired (`ledger.sequence() >= claim_ledger + lock_ledgers`); keeper's stake ≥ `MinStake` (if set); keeper's stored reputation ≥ `ReputationFloor` (if set). Keeper must auth. | None. The previous claimer's reputation gains a missed-claim mark. | `TaskClaimed` |
| T-4 | `execute_task` | `Claimed` | `Executed` | Contract not paused; keeper is the current claimer; `now < task.deadline`; `proof.len() <= MAX_PROOF_LEN`; if verifier attached: `verifier.try_verify(task_id, keeper, proof)` returns `Ok(Ok(true))`. Keeper must auth. | `escrow(task) -= reward`; `KeeperReward(keeper) += keeper_net`; `FeesAccrued += fee` (where `keeper_net + fee == reward`). If dispute window enabled: net reward goes to `PendingCredit` instead of directly to `KeeperReward`. | `TaskExecuted` |
| T-5 | `cancel_task` | `Pending` | `Cancelled` | Owner is the task owner; task owner must auth. (Pause not checked — owner may cancel even while paused.) | `escrow(task) -= reward`; `reward` transferred to `owner`. | `TaskCancelled` |
| T-6 | `cancel_task` | `Claimed` | `Cancelled` | Owner is the task owner; lock expired (`ledger.sequence() >= claim_ledger + lock_ledgers`). Owner must auth. | `escrow(task) -= reward`; `reward` transferred to `owner`. | `TaskCancelled` |
| T-7 | `expire_task` | `Pending` | `Expired` | `now >= task.deadline`. No auth required (permissionless). | `escrow(task) -= reward`; `reward` transferred to `owner`. | `TaskExpired` |
| T-8 | `expire_task` | `Claimed` | `Expired` | `now >= task.deadline`. No auth required (permissionless). | `escrow(task) -= reward`; `reward` transferred to `owner`. | `TaskExpired` |

### Non-state-changing entry points that require `Pending` or `Claimed`

These entry points validate the task status but do not change it:

| Entry point | Valid from states | Guards | Effect |
|---|---|---|---|
| `increase_reward` | `Pending`, `Claimed` | Owner is `task.owner`; `additional > 0`. Contract not paused. Owner must auth. | `task.reward += additional`; `escrow(task) += additional` (transferred from `owner`). |
| `extend_deadline` | `Pending`, `Claimed` | Owner is `task.owner`; `new_deadline > task.deadline`. Contract not paused. Owner must auth. | `task.deadline = new_deadline`. |
| `update_verifier` | `Pending` only | Owner is `task.owner`. Contract not paused. Owner must auth. | `task.verifier = new_verifier`. |

---

## Rejection table

Every (from-state, entry-point) pair that is NOT in the transition table
above returns a typed `KeeperError`. This table is exhaustive for the
task-lifecycle entry points.

| Entry point | From state(s) | Error returned | Reason |
|---|---|---|---|
| `claim_task` | `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Terminal state; no claim possible. |
| `claim_task` | `Claimed` (lock still active) | `LockPeriodActive` | Re-claim requires lock expiry (T-3 guard fails). |
| `claim_task` | any | `DeadlinePassed` | `now >= task.deadline`. |
| `claim_task` | any | `MinStakeNotMet` | Keeper stake below configured floor. |
| `claim_task` | any | `ReputationBelowFloor` | Keeper stored score below configured floor. |
| `execute_task` | `Pending`, `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Only `Claimed` tasks may be executed. |
| `execute_task` | `Claimed` (wrong keeper) | `NotTaskClaimer` | Only the current claimer may execute. |
| `execute_task` | `Claimed` | `DeadlinePassed` | `now >= task.deadline`. |
| `execute_task` | `Claimed` | `ProofTooLarge` | `proof.len() > MAX_PROOF_LEN`. |
| `execute_task` | `Claimed` | `VerificationFailed` | Verifier returned `false` or panicked; task stays `Claimed` (retryable). |
| `cancel_task` | `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Terminal state; no cancel possible. |
| `cancel_task` | `Claimed` (lock still active) | `LockPeriodActive` | Owner must wait for lock expiry before cancelling a `Claimed` task. |
| `cancel_task` | any | `NotTaskOwner` | Caller is not `task.owner`. |
| `expire_task` | `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Terminal state; no expiry possible. |
| `expire_task` | `Pending` or `Claimed` | `DeadlineNotPassed` | `now < task.deadline`. |
| `increase_reward` | `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Terminal state; reward is settled. |
| `increase_reward` | any | `NotTaskOwner` | Caller is not `task.owner`. |
| `increase_reward` | any | `InvalidReward` | `additional <= 0`. |
| `extend_deadline` | `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Terminal state; deadline is moot. |
| `extend_deadline` | any | `NotTaskOwner` | Caller is not `task.owner`. |
| `extend_deadline` | any | `DeadlinePassed` | `new_deadline <= task.deadline` (must be strictly later). |
| `update_verifier` | `Claimed`, `Executed`, `Cancelled`, `Expired` | `InvalidTaskStatus` | Verifier may only change before a claim locks it in. |
| `update_verifier` | any | `NotTaskOwner` | Caller is not `task.owner`. |
| any mutating entry point | any | `ContractPaused` | Registry is paused by admin (except `cancel_task`, `expire_task`, and `withdraw_rewards`, which are intentionally pause-exempt to protect owner and keeper funds). |
| any entry point | any | `NotInitialized` | `initialize` was never called. |
| any entry point | any | `TaskNotFound` | No task with this `task_id` exists. |

---

## State diagram

```
                        register_task
   (funded by owner) ────────────────▶  PENDING
                                            │  ╲
                            cancel_task     │   ╲ expire_task
                            (T-5)           │    ╲ (now >= deadline, T-7)
                                            ▼     ▼
                                       CANCELLED EXPIRED
                                                      ↑
                     claim_task (T-2)                 │ expire_task
                                            │         │ (now >= deadline, T-8)
                                            ▼         │
                                        CLAIMED ──────┘
                                         │  ▲   cancel_task (lock expired, T-6)
                       execute_task      │  │                    │
                       (verifier pass,   │  └────────────────────┘
                        T-4)             │   execute_task (verifier reject)
                                         │   task stays CLAIMED (retryable)
                                         ▼
                                       EXECUTED
```

---

## Verifier interaction

When a task has `task.verifier = Some(addr)`, `execute_task` calls
`KeeperVerifierClient::try_verify(task_id, keeper, proof)` **before** any
state mutation. The outcome:

| `try_verify` result | `execute_task` outcome | Task status after |
|---|---|---|
| `Ok(Ok(true))` | Proceeds: reward split, state → `Executed`. | `Executed` |
| `Ok(Ok(false))` | Returns `KeeperError::VerificationFailed`. No state changes. | `Claimed` (retryable) |
| `Ok(Err(_))` or `Err(_)` | Treated as `false`: returns `VerificationFailed`. No state changes. | `Claimed` (retryable) |

A `Claimed` task whose verifier always rejects eventually becomes `Expired`
when its deadline passes, and `expire_task` returns its escrow to the owner.
This ensures funds are never permanently stranded by a broken verifier.

---

## Balance conservation at each transition

Derived from the transition table; every row satisfies invariant I-1.

| Transition | Registry token balance change | Where the value goes |
|---|---|---|
| T-1 `register_task` | `+reward` | Escrowed from `owner`. |
| T-2/T-3 `claim_task` | 0 | No token movement; only task metadata updated. |
| T-4 `execute_task` | `-reward` | `+keeper_net` to `KeeperReward(keeper)`; `+fee` to `FeesAccrued`. Tokens remain inside the contract until `withdraw_rewards` / `sweep_fees`. |
| T-5/T-6 `cancel_task` | `-reward` | Transferred out to `owner`. |
| T-7/T-8 `expire_task` | `-reward` | Transferred out to `owner`. |

---

## Cross-references

| This document | Source of truth | Coverage in tests |
|---|---|---|
| States (`TaskStatus` enum) | `contracts/keeper-registry/src/types.rs` | `test/register.rs`, `test/claim.rs`, `test/cancel.rs`, `test/expire.rs` |
| Transition guards | `contracts/keeper-registry/src/task.rs` | `test/property.rs` — `property_no_transition_outside_state_machine_table` |
| Balance effects (I-1) | `contracts/keeper-registry/src/invariants.rs` | `test/property.rs` — `property_i1_solvency_*` |
| Verifier interaction | `docs/VERIFIER_DESIGN.md` | `test/verifier.rs`, `fuzz/fuzz_targets/conditioned_claim.rs` |
| Pause semantics | `contracts/keeper-registry/src/admin.rs` | `test/admin.rs` |
