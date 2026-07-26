---
title: "docs(registry): document and test the fee rounding behaviour for small rewards"
labels: [contract, docs, testing, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`split_reward` uses integer division, so the protocol fee always rounds **down** and the remainder goes to the keeper. For small rewards the fee rounds to zero entirely. This is reasonable behaviour, but it is undocumented and untested at the boundary, so nobody can tell whether it is intended.

## Current behaviour

```rust
/// Returns (keeper_net, protocol_fee).
fn split_reward(reward: i128, fee_bps: u32) -> (i128, i128) {
    let fee = reward
        .checked_mul(fee_bps as i128)
        .expect("overflow")
        .checked_div(10_000)
        .expect("div zero");
    (reward.checked_sub(fee).expect("underflow"), fee)
}
```

At the default 300 bps (3%), any reward below 34 stroops yields a fee of 0:

| reward | fee_bps | fee | keeper_net | effective rate |
|--------|---------|-----|------------|----------------|
| 1 | 300 | 0 | 1 | 0% |
| 33 | 300 | 0 | 33 | 0% |
| 34 | 300 | 1 | 33 | 2.9% |
| 100 | 300 | 3 | 97 | 3% |
| 10_000_000 | 300 | 300_000 | 9_700_000 | 3% |

The existing `test_split_reward_invariants` test checks that the parts sum to the whole, which is the important invariant, but it does not pin the rounding direction or the dust boundary.

## Why this is worth writing down

Rounding *toward the keeper* is the right default — it means the contract can never take more than the stated fee rate, and the error is bounded by one stroop per execution. But "right default" is only useful if it is a stated guarantee. Three groups need it stated:

- **Auditors**, who will otherwise flag the unchecked rounding as a finding and require an explanation.
- **The treasury and governance work**, which will reconcile expected revenue against actual fees and needs to know that a shortfall of up to one stroop per task is expected, not a bug.
- **Anyone setting `min_reward`**, since the dust threshold is exactly where fee collection stops working. At 300 bps a `min_reward` below 34 means the protocol earns nothing on those tasks while still bearing their storage cost.

That last point is the practical one, and it connects two parameters that are currently set independently with no documented relationship.

## Expected behaviour

The rounding direction is a documented guarantee, tested at its boundaries, and the interaction between `min_reward` and the fee rate is explained.

## Suggested approach

This issue is documentation and tests — no behaviour change. If you conclude the behaviour *should* change, open a separate issue rather than changing it here.

Extend the `split_reward` doc comment to state the guarantee explicitly: the fee is `floor(reward * fee_bps / 10_000)`, the keeper receives the remainder, and the protocol therefore never collects more than the nominal rate.

Add tests covering the boundary rather than only the invariant:

- `reward = 1`, non-zero fee — asserts fee is 0 and the keeper gets everything.
- The exact reward at which the fee first becomes 1, for the default rate.
- `fee_bps = 0` — keeper gets the whole reward.
- `fee_bps = 10_000` — the entire reward becomes fee and the keeper gets 0. Worth asserting deliberately, because it is a legal admin setting and it is the one case where a keeper works for nothing.

Add a short note to the README tokenomics section on the `min_reward` / `fee_bps` interaction, including the formula for the dust threshold: `min_reward >= ceil(10_000 / fee_bps)` for the fee to be non-zero.

## Acceptance criteria

- [ ] `split_reward`'s doc comment states the rounding direction as a guarantee and explains who benefits.
- [ ] Tests cover reward = 1, the first reward yielding a non-zero fee, `fee_bps = 0`, and `fee_bps = 10_000`.
- [ ] Every test asserts the sum invariant `keeper_net + fee == reward` alongside the specific values.
- [ ] The README documents the dust threshold and its relationship to `min_reward`.
- [ ] No behaviour change — existing tests pass unmodified.

## Files

- `contracts/keeper-registry/src/lib.rs` — `split_reward` doc comment
- `contracts/keeper-registry/src/test.rs`
- `README.md` — tokenomics

## Getting started

Good first issue. `test_split_reward_invariants` shows the existing pattern. The arithmetic is simple and the value is in stating the guarantee precisely.
