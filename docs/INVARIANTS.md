# KeeperRegistry invariants

This document is the single reference for the money invariants enforced by the
`KeeperRegistry` contract. The authoritative assertions live in
[`contracts/keeper-registry/src/invariants.rs`](../contracts/keeper-registry/src/invariants.rs);
both the `proptest` suite and any fuzz targets call those shared functions so
the meaning of an invariant cannot drift between suites. This page gives each
one a plain-language statement and points at the test that enforces it.

The identifiers `I-1` through `I-7` are the ones defined in `invariants.rs` and
introduced in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#invariants). Other
design documents define further invariants with their own numbering
(`I-8`..`I-11` for TTL/staking and `T-1`..`T-3` for governance). Those are
**not** implemented in `invariants.rs` and are therefore out of scope for this
reference; see [Related invariants](#related-invariants-outside-invariantsrs)
for links.

## Invariants

### I-1 — Solvency

**Plain language:** the registry is never short of tokens. The number of
tokens it holds always equals the sum of everything it owes: rewards still
escrowed in open tasks, credited keeper balances, accrued protocol fees,
bonded and mid-unbond keeper stake, and execution credits still inside their
dispute window.

**Assertion:** [`assert_solvent`](../contracts/keeper-registry/src/invariants.rs#L88)

**Enforced by:**

- [`property_i1_solvency_holds_across_random_task_outcomes`](../contracts/keeper-registry/src/test/property.rs#L41) — random task outcomes over the base escrow model.
- [`property_i1_solvency_holds_with_verifier_attached_tasks`](../contracts/keeper-registry/src/test/property.rs#L89) — tasks with an attached verifier.
- [`property_i1_solvency_holds_with_stake_unbond_slash_and_dispute_window`](../contracts/keeper-registry/src/test/property.rs#L179) — the E06 extension: bonded stake, pending unbonds, slashes and pending execution-dispute credits.

This third test caught a real bug: an upheld dispute used to drop a pending
credit without sending its tokens anywhere, silently breaking I-1. The fix
was in `resolve_execution_dispute`, not in the assertion.

### I-2 — Escrow recoverability

**Plain language:** a reward that has been escrowed is never stuck. A claimed
task whose deadline has passed can always be expired by anyone, returning the
reward to its owner.

**Assertion:** [`assert_lapsed_claim_is_expirable`](../contracts/keeper-registry/src/invariants.rs#L177)

**Note:** this assertion calls `expire_task` and mutates contract state on the
successful path. It is a sequence step, not a read-only check.
**Enforced by:** [`property_i2_lapsed_claim_is_always_expirable`](../contracts/keeper-registry/src/test/property.rs#L325).

### I-3 — Single payout

**Plain language:** a task pays out at most once. Around any single settling
call (`execute_task`, `cancel_task` or `expire_task`) the relevant balance
changes by exactly the expected amount — never twice.

**Assertion:** [`assert_single_payout`](../contracts/keeper-registry/src/invariants.rs#L220)

**Enforced by:** [`property_i3_single_payout_not_doubled`](../contracts/keeper-registry/src/test/property.rs#L343).

### I-4 — Fee bounding

**Plain language:** the protocol never takes more than the configured
`fee_bps` of a reward, and the keeper's net pay plus the protocol fee adds up
exactly to the original reward. No value is created or destroyed, and no share
is negative. Floor division may make the fee marginally *less* than the
nominal rate, never more.

**Assertion:** [`assert_fee_bounded`](../contracts/keeper-registry/src/invariants.rs#L242)

**Enforced by:** [`property_i4_fee_bounded_across_arbitrary_inputs`](../contracts/keeper-registry/src/test/property.rs#L372).

### I-5 — Escrow isolation

**Plain language:** admin housekeeping never touches user money. Calls such
as `sweep_fees`, `set_fee_bps`, `set_min_reward`, `pause`, `unpause`,
`transfer_admin` and `upgrade` may move only protocol fees; they must leave
every task's escrow and every keeper's credited balance unchanged.

`slash` is deliberately excluded: moving a keeper's stake is its entire
purpose, so including it here would make the invariant wrong rather than
merely untested. Stake invariants belong to I-1 and the staking design.

**Assertion:** [`assert_admin_action_isolated`](../contracts/keeper-registry/src/invariants.rs#L292)

**Enforced by:** [`property_i5_sweep_fees_isolated_from_escrow_and_keeper_balances`](../contracts/keeper-registry/src/test/property.rs#L386).

### I-6 — Withdrawal liveness

**Plain language:** a keeper with a positive credited balance can always
withdraw it in full, even while the contract is paused. Pausing may stop new
work, but it must never trap already-earned rewards.

**Assertion:** [`assert_withdrawal_live`](../contracts/keeper-registry/src/invariants.rs#L318)

**Enforced by:** [`property_i6_withdrawal_live_while_paused`](../contracts/keeper-registry/src/test/property.rs#L428).

### I-7 — Monotonic task ids

**Plain language:** task ids are strictly increasing and never reused, so an
id from the past can never be confused with a newly registered task.

**Assertion:** [`assert_task_ids_monotonic`](../contracts/keeper-registry/src/invariants.rs#L354)

**Enforced by:** [`property_i7_task_ids_strictly_increasing`](../contracts/keeper-registry/src/test/property.rs#L446).

## Coverage summary

| Invariant | Assertion in `invariants.rs` | Property test |
| --- | --- | --- |
| I-1 Solvency | `assert_solvent` | three `property_i1_*` tests (base, verifier, staking/dispute) |
| I-2 Escrow recoverability | `assert_lapsed_claim_is_expirable` | `property_i2_lapsed_claim_is_always_expirable` |
| I-3 Single payout | `assert_single_payout` | `property_i3_single_payout_not_doubled` |
| I-4 Fee bounding | `assert_fee_bounded` | `property_i4_fee_bounded_across_arbitrary_inputs` |
| I-5 Escrow isolation | `assert_admin_action_isolated` | `property_i5_sweep_fees_isolated_from_escrow_and_keeper_balances` |
| I-6 Withdrawal liveness | `assert_withdrawal_live` | `property_i6_withdrawal_live_while_paused` |
| I-7 Monotonic task ids | `assert_task_ids_monotonic` | `property_i7_task_ids_strictly_increasing` |

### Gaps

There are **no invariants in `invariants.rs` without at least one property
test**. Every function above is called by a dedicated `#[test]` in
[`contracts/keeper-registry/src/test/property.rs`](../contracts/keeper-registry/src/test/property.rs).

Two caveats worth recording:

- I-2 is checked only for the concrete "claimed and past deadline is
  expirable now" case, not as a full sequence proof that every escrowed
  reward reaches a terminal state. This is documented in the assertion's own
  comment and is a known limitation rather than an accidental omission.
- The repository has no fuzz targets at present. `invariants.rs` is written
  to be shared with fuzz targets (`#![cfg(any(test, fuzzing))]`), so adding
  one later requires no new assertion logic, only a new caller.

## Related invariants outside `invariants.rs`

These are not part of `invariants.rs` but are referenced elsewhere and may be
useful when auditing the whole system:

- **I-8, I-9, I-11** (TTL and staking invariants) —
  [`docs/ARCHITECTURE.md`](ARCHITECTURE.md),
  [`docs/STAKING_DESIGN.md`](STAKING_DESIGN.md), and the corresponding
  `property_i8_*` / `property_i9_*` tests in
  [`property.rs`](../contracts/keeper-registry/src/test/property.rs).
- **I-10** (a slash never exceeds a keeper's current stake) —
  [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).
- **T-1..T-3** (governance proposal lifecycle) —
  [`docs/GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) and
  [`docs/GOVERNANCE_SECURITY_REVIEW.md`](GOVERNANCE_SECURITY_REVIEW.md).
- Treasury conservation —
  [`docs/TREASURY_DESIGN.md`](TREASURY_DESIGN.md) and
  [`contracts/treasury/src/test/conservation.rs`](../contracts/treasury/src/test/conservation.rs).
