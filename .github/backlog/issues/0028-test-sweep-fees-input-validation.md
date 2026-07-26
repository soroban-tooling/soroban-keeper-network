---
title: "test(registry): cover sweep_fees input validation and partial sweeps"
labels: [testing, contract, good-first-issue]
epic: E02
wave: 1
depends_on: []
---

## Summary

`sweep_fees` validates its amount in two ways and neither rejection path is fully tested. Partial sweeps — the normal case for a treasury drawing down revenue incrementally — are untested entirely.

## Current coverage

- `test_sweep_fees_to_treasury` — sweeps some amount.
- `test_sweep_more_than_accrued_fails` — over-sweep rejected.
- `test_sweep_by_non_admin_fails` — auth.

## The gaps

The validation is:

```rust
if amount <= 0 {
    return Err(KeeperError::InvalidReward);
}
let accrued: i128 = e
    .storage()
    .instance()
    .get(&DataKey::FeesAccrued)
    .unwrap_or(0);
if amount > accrued {
    return Err(KeeperError::NoRewardsAvailable);
}
```

Untested:

**`amount == 0` and `amount < 0`.** Both hit the first guard. A negative amount is the interesting one: without that guard, `accrued - amount` would *increase* the accumulator while the token transfer moved value in the wrong direction. The guard is correct; nothing proves it stays there.

**Sweeping with nothing accrued.** `unwrap_or(0)` means any positive amount is rejected with `NoRewardsAvailable`. Reachable on a fresh contract before any task executes.

**Partial sweeps and the running remainder.** Nothing asserts that sweeping part of the balance leaves the rest correctly, or that repeated partial sweeps sum to the total without drift. This is the ordinary operating pattern and it is the one path where an arithmetic slip compounds.

**Sweeping exactly the accrued amount.** The boundary: `amount > accrued` means `amount == accrued` must succeed and leave exactly zero.

**Note the error naming.** A zero or negative sweep returns `InvalidReward`, which mentions a reward that is not involved. Worth a comment on this issue if you think a distinct variant is warranted — but do not change it in a test-only PR.

## Expected behaviour

Every branch of the validation has a test, and partial sweeps are proven to conserve the accumulator.

## Suggested approach

- Assert `amount = 0` and `amount = -1` are both rejected, and that `fees_accrued` is unchanged after each.
- Assert a sweep against a zero accumulator is rejected.
- Accrue a known fee total by executing tasks, then sweep it in three uneven parts, asserting `fees_accrued` after each and that the treasury's token balance matches the running total.
- Assert a final sweep of exactly the remainder succeeds and leaves zero.
- Assert a further sweep of 1 is then rejected.
- Assert throughout that no task escrow or keeper balance was touched — this is the property the accumulator exists to guarantee. Register an unrelated open task first and assert its reward is still intact at the end.

That last point is the substance of the issue. `sweep_fees` is the only function where an admin moves money it does not own, and the accumulator is the only thing bounding it.

## Acceptance criteria

- [ ] Zero, negative, and empty-accumulator sweeps are each tested and asserted not to change state.
- [ ] A sequence of partial sweeps is asserted against a running remainder.
- [ ] Sweeping exactly the accrued amount succeeds and leaves zero.
- [ ] A test asserts an unrelated open task's escrow is untouched by sweeping.
- [ ] A test asserts a credited keeper balance is untouched by sweeping.

## Files

- `contracts/keeper-registry/src/test.rs`

## Getting started

Good first issue. `test_sweep_fees_to_treasury` and `test_sweep_more_than_accrued_fails` show the setup; the additions are mostly more assertions on the same scenario.
