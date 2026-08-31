---
title: "test(fuzz): fuzz execute_task's proof and reward-split arithmetic"
labels: [testing, contract, intermediate]
epic: E03
wave: 2
depends_on: [0051, 0052]
---

## Summary

`execute_task` runs `split_reward`, which does a `checked_mul`/`checked_div` against `fee_bps` and `reward`, then credits a keeper balance with `checked_add`. These are exactly the kind of paths fuzzing is good at: the unit tests exercise a handful of representative values, not the full input space.

## Expected behaviour

A `fuzz_targets/execute_task.rs` target that registers a task with a fuzzed `reward` (within the range `register_task` currently accepts), fuzzes the `proof` bytes up to and beyond `MAX_PROOF_LEN`, claims and executes it, and asserts:
- The call never panics regardless of `proof` size or content.
- When it succeeds, `keeper_net + fee == task.reward` exactly (no dust lost or created — this is I-4 from the invariants doc, issue 0050).
- `fees_accrued()` after the call equals `fees_accrued()` before plus `fee`.

## Suggested approach

Fuzz `fee_bps` too, by driving it through `set_fee_bps` before execution, within `[0, 10_000]` — values outside that range are already rejected by `set_fee_bps` itself and are out of scope here.

## Acceptance criteria

- [ ] Target asserts the exact-conservation property above on every successful execution, not just "it didn't crash."
- [ ] `proof` length is fuzzed both below and above `MAX_PROOF_LEN` (see issue 0004 in wave 1) to exercise the boundary.
- [ ] 10+ minutes of local fuzzing with no crash or conservation-property failure.
- [ ] Any crash's minimized input is committed to `fuzz/corpus/execute_task/`.

## Files

- `fuzz/fuzz_targets/execute_task.rs`
