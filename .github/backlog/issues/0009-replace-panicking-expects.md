---
title: "refactor(registry): replace panicking expect calls in arithmetic helpers with typed errors"
labels: [contract, enhancement, intermediate]
epic: E01
wave: 1
depends_on: [0008]
---

## Summary

Four helpers panic on arithmetic edge cases rather than returning a `KeeperError`. CONTRIBUTING forbids this pattern outside genuinely unreachable states, and at least one of these is reachable.

## Current behaviour

```rust
// next_task_id
let next = id.checked_add(1).expect("task id overflow");

// split_reward
let fee = reward
    .checked_mul(fee_bps as i128)
    .expect("overflow")
    .checked_div(10_000)
    .expect("div zero");
(reward.checked_sub(fee).expect("underflow"), fee)

// credit_keeper
let updated = current
    .checked_add(amount)
    .expect("keeper balance overflow");

// accrue_fee
let updated = current
    .checked_add(amount)
    .expect("fee accumulator overflow");
```

## Assessment of each

Not all four are equally serious, and the PR should treat them differently rather than mechanically converting everything.

**`split_reward` — the multiply is reachable.** `reward` is an `i128` supplied by the caller and `fee_bps` can be up to `10_000`. Any reward above `i128::MAX / 10_000` overflows the multiplication. That is an absurd token amount, but nothing in `register_task` bounds `reward` from above, so the input is accepted and the panic is reachable by a caller who wants to trigger it. The `checked_div(10_000)` can never fail — the divisor is a non-zero literal — so `expect("div zero")` is dead code and misleading; delete it or replace it with a plain division and a comment.

**`credit_keeper` — reachable only in aggregate.** A single credit cannot overflow if rewards are bounded, but the running total across many executions theoretically can. Bounding `reward` at registration is the cleaner fix and makes this genuinely unreachable.

**`next_task_id` — not reachable in practice.** Exhausting `u64` requires 18 quintillion registrations. This one can legitimately keep an `expect`, but the message should say *why* it is unreachable, per CONTRIBUTING.

**`accrue_fee` — same as `credit_keeper`.**

## Expected behaviour

Reachable arithmetic failures return a typed error. Genuinely unreachable ones keep `expect` with a message that explains the reasoning.

## Suggested approach

Add an `ArithmeticOverflow` variant, appended to preserve existing discriminants. Convert `split_reward`, `credit_keeper`, and `accrue_fee` to return `Result` and propagate with `?`.

Consider also bounding `reward` from above in `register_task` and `increase_reward`. A `MAX_REWARD` constant makes several of these overflows structurally impossible, which is better than handling them. If you take that route, say so and leave the errors in place as defence in depth.

For `next_task_id`, keep the panic but fix the message:

```rust
// Unreachable: exhausting u64 task ids requires ~1.8e19 registrations, far
// beyond any plausible lifetime of this contract.
let next = id.checked_add(1).expect("task id counter exhausted");
```

## Acceptance criteria

- [ ] Reachable overflow paths return a typed error rather than panicking.
- [ ] The dead `checked_div(10_000).expect("div zero")` is removed or justified.
- [ ] Any remaining `expect` in contract code has a comment explaining why the state is unreachable.
- [ ] A test asserts the overflow error is returned for an extreme reward value rather than the call panicking.
- [ ] `cargo clippy --workspace --all-targets` reports no new warnings.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`

## References

- CONTRIBUTING.md, "Code Style" — the no-`unwrap()` rule and the `expect` exception.
- Depends on the `NotInitialized` issue only for the error-variant numbering; coordinate so the two PRs do not both claim discriminant 14.
