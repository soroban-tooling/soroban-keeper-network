# Cross-Contract Call Review (issue #740)

The keeper registry calls out to three kinds of external contract: the **task
condition**, the **task verifier**, and the **reward token**. Every one of
those is attacker-influenced — a task owner chooses the condition and verifier
addresses, and the reward token is an address chosen at initialisation — so
each call is a trust boundary. This document is the review of all three.

It is written from the code, not from intent. For every call site it records:

- **State written before the call** — the "effects" a re-entering callee would
  observe if the host allowed re-entry.
- **State written after the call** — what completes once the callee returns.
- **Failure handling** — whether a rejected or panicking callee is isolated or
  aborts the transaction, and what state is left behind.
- **Malicious-callee analysis** — what the worst-case callee can and cannot do.

`contracts/keeper-registry/src/test/cross_contract.rs` contains one explicitly
named malicious-callee test per call type, named `malicious_<type>_*`, plus a
source-scan test that fails if a new external call appears in a production
module without being added to the tables below. That test is the guarantee
behind the word "every" here.

## Summary of the trust model

| Call type | Interface | Who chooses the address | Failure handling | Worst case |
| --- | --- | --- | --- | --- |
| Condition | `ITaskCondition::is_met` | task owner, at registration | `try_is_met`, non-`true` → `ConditionNotMet` (or `false` in the view) | deny claims for its own task, or re-enter — both contained |
| Verifier | `IKeeperVerifier::verify` | task owner, at registration/update | `try_verify`, non-`true` → `VerificationFailed` | deny execution for its own task, or re-enter — both contained |
| Reward token | SEP-41 `transfer` | admin, at initialisation | plain `transfer` — a failure aborts the whole transaction (atomic revert) | re-enter, or refuse transfers (liveness only — it cannot steal) |

Two properties hold across all three:

1. **No external call is made until every local guard has passed.** The
   condition and verifier gates run before the first state write of their
   entry point; token transfers run either after the effects they settle
   (CEI paths) or at registration where the only prior write is the instance
   TTL bump and the task does not yet exist.
2. **A panicking condition or verifier can never brick a task.** Both are
   invoked through the generated client's `try_*` variant, so a callee trap is
   caught and mapped to the typed rejection above. The task stays `Pending` /
   `Claimed` and is still retryable; at the deadline `expire_task` remains
   available as a permissionless escape hatch. A panicking token, by contrast,
   aborts the transaction — which is safe because Soroban rolls back all of
   that transaction's writes atomically.

---

## 1. Condition calls — `TaskConditionClient::try_is_met`

Declared in `contracts/keeper-registry/src/condition.rs`. The interface returns
a single `bool`; the registry accepts only `Ok(Ok(true))`, so `false`, a
malformed return value, a missing contract, and a callee panic all collapse to
the same closed result.

### Call sites

| # | Entry point (source) | State written **before** the call | State written **after** the call | Failure handling |
| --- | --- | --- | --- | --- |
| 1.1 | `task.rs::claim_task` | None. `require_not_paused`, `keeper.require_auth`, min-stake floor, `load_task`, deadline, claim-lock, and reputation-floor checks are all reads. | `bump_instance`; a missed-claimer reputation record (takeover only); `status = Claimed`, `claimer`, `claim_ledger`, `save_task`; `TaskClaimed` event. | `try_is_met` is not `Ok(Ok(true))` → emit `ConditionNotMet` (if an address is present) and return `KeeperError::ConditionNotMet`. **No write has happened yet**, so the task is byte-for-byte unchanged. |
| 1.2 | `views.rs::is_claimable` | None — this is a read-only view. It never writes storage or bumps TTL. | None. | Any non-`true` result → `false`. The view fail-closed exactly like the real claim path, so indexers and keeper bots cannot be tricked into thinking a claim will succeed by a broken condition. |

### Malicious-callee analysis

A condition is chosen by the task owner, so the owner can point it at any
address — including one that panics, returns garbage, or calls back into the
registry.

- **Denial of claim:** expected and harmless. The condition governs the
  owner's own task; returning `false` only denies keeper claims on it. The
  owner cannot use it to take escrow from someone else, and the permissionless
  `expire_task` still refunds the owner at the deadline.
- **Panic:** isolated by `try_is_met`; identical to `false` (test:
  `test/condition.rs::panicking_condition_is_isolated_and_fails_closed`).
- **Missing/invalid contract address:** also isolated (`test/condition.rs::
  missing_condition_contract_fails_closed`).
- **Re-entry:** the call is at the top of `claim_task`, before *any* write.
  Even if the host permitted re-entry, a re-entrant caller would observe only
  the consistent pre-claim state (task still `Pending` for 1.1). In practice
  the host's reentrancy guard rejects the nested call as well. The doc's test
  `malicious_condition_cannot_mutate_registry_during_claim` pins this: a
  condition that tries to call `set_fee_bps` during `is_met` cannot change the
  fee, and the outer claim still succeeds with correct state.

---

## 2. Verifier calls — `KeeperVerifierClient::try_verify`

Declared in `contracts/keeper-registry/src/verifier.rs`. Design rationale and
the panic-isolation decision are recorded in `docs/VERIFIER_DESIGN.md` §1-2.
As with the condition, only `Ok(Ok(true))` counts as approval.

### Call sites

| # | Entry point (source) | State written **before** the call | State written **after** the call | Failure handling |
| --- | --- | --- | --- | --- |
| 2.1 | `task.rs::execute_task` | None. Pause, auth, proof length, `load_task`, status, claimer identity and deadline are all reads. | `bump_instance`; reward split; `credit_keeper` **or** `add_pending_credit` (E06 dispute window); `accrue_fee`; `record_success`; `status = Executed`, `save_task`; `TaskExecuted` event. | `try_verify` not `Ok(Ok(true))` → emit `TaskVerificationFailed` (if an address is present) and return `KeeperError::VerificationFailed`. No write has happened, so the task is still `Claimed`, the reward is still escrowed, and the keeper can retry with a different proof. |

### Malicious-callee analysis

The verifier is attached by the task owner at registration (or via
`update_verifier` while the task is still `Pending`).

- **Reject everything / panic:** isolated as `VerificationFailed`; the task
  stays `Claimed` and retryable, and `expire_task` refunds the owner at the
  deadline. Tests: `test/verifier.rs::test_execute_task_with_rejecting_verifier_fails_without_moving_funds`
  and `::test_execute_task_with_panicking_verifier_is_isolated_as_verification_failed`.
- **Approve everything:** the verifier is *an additional* gate, not a
  replacement for the registry's own checks. Even an always-approve verifier
  cannot make `execute_task` bypass claimer identity, deadline, proof size, or
  task status — those guards all run before the call.
- **Re-entry:** the call is before the first write, so a re-entrant caller sees
  only the consistent pre-execution state (still `Claimed`, nothing credited).
  The doc's test `malicious_verifier_cannot_mutate_registry_during_execute`
  pins this with a verifier that attempts `set_fee_bps` during `verify`.

---

## 3. Reward-token calls — `token::Client::transfer`

The reward token is fixed at initialisation by the admin. It is a SEP-41
contract, and the registry invokes the plain (non-`try_`) `transfer`: a
rejection or trap aborts the transaction, and Soroban's atomic rollback undoes
every write the registry made in that transaction. There is no partial state
to clean up. The CEI ordering below is therefore defence-in-depth against a
**re-entrant** token — one that calls back into the registry from inside
`transfer` — which would otherwise observe an intermediate state.

### Call sites

| # | Entry point (source) | Direction | State written **before** the call | State written **after** the call | Re-entrancy defence |
| --- | --- | --- | --- | --- | --- |
| 3.1 | `task.rs::register_task` | owner → registry | `bump_instance` only. The task does not exist yet — `next_task_id`/`save_task` happen after the transfer. | `next_task_id`; `save_task` (status `Pending`); `TaskRegistered` event. | A re-entrant call cannot reference the new task (no id exists yet) and cannot double-spend: its `require_auth` would have to be the owner's, and the transfer debits the owner first at the token layer. |
| 3.2 | `task.rs::increase_reward` | owner → registry | `bump_instance` only; `task.reward` is still the old value. | `task.reward += additional`; `save_task`; `RewardIncreased` event. | Status guard already restricted the task to `Pending`/`Claimed`; a re-entrant top-up would be a separate, independently authorised transfer. |
| 3.3 | `task.rs::cancel_task` | registry → owner | `status = Cancelled`, `save_task`. | `TaskCancelled` event. | The status guard rejects a re-entrant cancel (`InvalidTaskStatus`), so the refund cannot be paid twice from pooled escrow. Test: `test/cancel.rs::test_cancel_task_rejects_reentrant_refund`. |
| 3.4 | `task.rs::expire_task` | registry → owner | `status = Expired`, `save_task`. | `TaskExpired` event. | Same status guard rejects a re-entrant expiry. Test: `test/expire.rs::test_expire_task_rejects_reentrant_refund`. |
| 3.5 | `task.rs::withdraw_rewards` | registry → keeper | `finalize_rewards` (pending credits → balance); `KeeperReward = 0`. | `RewardsWithdrawn` event. | Zeroing before the transfer means a re-entrant withdrawal sees `NoRewardsAvailable`. Covered by the doc's `malicious_token_reentry_during_reward_withdrawal_cannot_double_spend` using the shared `ReentrantToken` mock. |
| 3.6 | `admin.rs::sweep_fees` | registry → treasury | `FeesAccrued = accrued - amount` (instance). | `FeesSwept` event. | The debit bounds the sweep to accrued fees, so a re-entrant sweep can never reach task escrow or keeper balances. |
| 3.7 | `batch.rs::batch_register_tasks` | owner → registry (N transfers) | `bump_instance` only; no task from this batch exists until its transfer completes. All validation and the `max_total_reward` ceiling were checked before the loop. | One `save_task` + `TaskRegistered` event per entry; `BatchRegistered` summary event. | Each iteration writes its task immediately after its own transfer; a re-entrant call can never see a half-created batch, and the ceiling caps total exposure. |
| 3.8 | `staking.rs::stake_deposit` | keeper → registry | `KeeperStake = current + amount` (persistent) and its TTL extended. | `StakeDeposited` event. | The write precedes the interaction; a re-entrant deposit is a separate, authorised transfer. |
| 3.9 | `staking.rs::withdraw_stake` | registry → keeper | `UnbondRequest` removed. | `StakeWithdrawn` event. | Removal before transfer means a re-entrant withdrawal sees `NoPendingUnbond`. |
| 3.10 | `staking.rs::slash` | registry → treasury | `KeeperStake` debited; `SlashRecord` written; `SlashHistory` written. | `Slashed` event. | All effects precede the transfer, so a re-entrant slash sees the already-reduced stake and already-created record. |
| 3.11 | `staking.rs::resolve_slash_appeal` (upheld only) | admin → registry | `SlashRecord` removed; `KeeperStake` credited back on an upheld appeal. | `SlashAppealResolved` event. | The record is removed before the transfer, so a second resolution cannot refund twice. |

### Malicious-callee analysis

- **Refuse a transfer:** liveness only. The transaction reverts atomically, so
  no state is left half-written; a keeper/owner can retry later. The admin can
  replace the token only by upgrading the contract.
- **Re-enter:** the dominant hazard, because a malicious token can call any
  registry entry point from inside `transfer`. Every state-changing call site
  above either writes its settling effect before the transfer (3.3-3.6,
  3.8-3.11) or has no existing state to corrupt yet (3.1, 3.2, 3.7). The
  host's own reentrancy guard is a second, independent layer. The regression
  tests for 3.3 and 3.4 assert *both*: the nested call never succeeds, and if
  it ever reaches the registry's own guard it is rejected with
  `InvalidTaskStatus`.
- **Return fake balances:** the registry never trusts token-returned values for
  accounting; every amount comes from its own storage (`task.reward`,
  `FeesAccrued`, `KeeperReward`, `UnbondRequest.amount`). A lying `balance()`
  cannot inflate a payout.

---

## Test index

| Call type | Test | Location |
| --- | --- | --- |
| condition | `malicious_condition_cannot_mutate_registry_during_claim` | `test/cross_contract.rs` |
| condition | `panicking_condition_is_isolated_and_fails_closed` | `test/condition.rs` |
| condition | `missing_condition_contract_fails_closed` | `test/condition.rs` |
| verifier | `malicious_verifier_cannot_mutate_registry_during_execute` | `test/cross_contract.rs` |
| verifier | `test_execute_task_with_rejecting_verifier_fails_without_moving_funds` | `test/verifier.rs` |
| verifier | `test_execute_task_with_panicking_verifier_is_isolated_as_verification_failed` | `test/verifier.rs` |
| token | `malicious_token_reentry_during_reward_withdrawal_cannot_double_spend` | `test/cross_contract.rs` |
| token | `test_cancel_task_rejects_reentrant_refund` | `test/cancel.rs` |
| token | `test_expire_task_rejects_reentrant_refund` | `test/expire.rs` |
| all | `every_external_call_is_documented` | `test/cross_contract.rs` |

The `every_external_call_is_documented` test scans every production module for
the three call shapes (`TaskConditionClient::`, `KeeperVerifierClient::`, and
`reward_token(&e)?.transfer` / `token.transfer`) and fails if a new call site
appears in source but not in this document, so this review cannot silently go
stale.
