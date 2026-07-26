---
title: "test(registry): cover fee_bps boundary values including the 100% case"
labels: [testing, contract, good-first-issue]
epic: E02
wave: 1
depends_on: []
---

## Summary

`set_fee_bps` accepts anything from 0 to 10,000 inclusive. Only rejection above the maximum and one mid-range value are tested. The two boundaries — 0% and 100% — are untested, and the 100% case has a consequence worth pinning down.

## Current coverage

- `test_set_fee_over_max_fails` — rejects 10,001.
- `test_set_fee_bps_affects_future_executions` — one mid-range change.
- `test_initialize_fee_over_10000_fails` — same bound at initialize.

## The gaps

**`fee_bps = 0`.** Legal and probably the intended launch setting. `split_reward` returns `(reward, 0)`, `accrue_fee` early-returns on zero, and no fee entry is written. Nothing asserts the keeper receives the entire reward or that `fees_accrued` stays at zero.

**`fee_bps = 10_000`.** Also legal — the guard is `if new_bps > 10_000`, so exactly 10,000 passes. `split_reward` then returns `(0, reward)`: the keeper is credited **nothing** and the entire reward becomes protocol fee.

That last case is worth a deliberate test, because a keeper executing a task under a 100% fee spends a transaction fee to earn zero. Two follow-on questions the test will settle:

- Does `credit_keeper` write a zero-value persistent entry? Looking at the code it does — there is no zero guard — which means an execution at 100% fee costs a storage write for a balance that can never be withdrawn, since `withdraw_rewards` rejects a zero balance with `NoRewardsAvailable`.
- Does `TaskExecuted` emit a net reward of 0? It should, and an indexer needs to handle that row.

Whether a 100% fee should be *allowed* is a separate question. This issue is about knowing what happens today.

**The boundary itself.** No test asserts that exactly 10,000 is accepted. If the guard were tightened to `>=`, nothing would catch it.

## Expected behaviour

Both boundaries are tested, and the 100%-fee execution path is fully characterised.

## Suggested approach

Add:

- `fee_bps = 0`: execute a task, assert the keeper is credited the full reward and `fees_accrued` is zero.
- `fee_bps = 10_000` accepted by `set_fee_bps` and by `initialize`.
- Execute under a 100% fee and assert: keeper credited 0, `fees_accrued` equals the full reward, `TaskExecuted` carries a net reward of 0, and a subsequent `withdraw_rewards` fails with `NoRewardsAvailable`.
- Assert the solvency invariant holds at 100% — the contract still owes exactly what it holds, just all of it to the treasury.

If the zero-value storage write bothers you, note it on this issue and open a separate one for adding a zero guard to `credit_keeper`. Do not change behaviour in a test-only PR.

## Acceptance criteria

- [ ] A test covers `fee_bps = 0` end to end.
- [ ] A test asserts `fee_bps = 10_000` is accepted by both `set_fee_bps` and `initialize`.
- [ ] A test characterises execution under a 100% fee, including the failed withdrawal.
- [ ] The 100% behaviour is documented on `set_fee_bps`'s doc comment.
- [ ] No behaviour change in this PR.

## Files

- `contracts/keeper-registry/src/test.rs`
- `contracts/keeper-registry/src/lib.rs` — doc comment only
