---
title: "feat(rust-sdk): typed wrappers for every read-only view"
labels: [rust-sdk, enhancement, good-first-issue]
epic: E13
wave: 3
depends_on: [0198, 0199]
---

## Summary

The registry exposes eleven read-only views beyond get_task: task_count, keeper_balance, admin, get_fee_bps, is_paused, reward_token_address, is_claimable, min_reward, max_batch_size, fees_accrued, and version. None are wrapped yet.

## Expected behaviour

One method per view, each a plain simulation call with no signing required, matching the pattern the keeper-bot's readContract helper already established for the JavaScript side (issue 0031, wave 1): views never submit a transaction.

## Suggested approach

This is the most mechanical issue in the epic and a reasonable first pick if you are new to the SDK crate. Each method is a thin wrapper: build the invocation, simulate, decode the return value. There is no per-method complexity beyond getting the return type right; is_paused and is_claimable return bool, keeper_balance and fees_accrued and min_reward return i128, task_count returns u64, and so on. Get each type exactly right rather than defaulting everything to a permissive type like i128.

## Acceptance criteria

- [ ] All eleven views implemented.
- [ ] Each method is documented as read-only / simulation-only in its rustdoc, so a caller does not assume it needs a signing key.
- [ ] A single integration test calls each view once against a freshly initialized registry and asserts the documented default (is_paused false, fees_accrued 0, and so on).

## Files

- rust-sdk/src/client.rs
- rust-sdk/tests/views.rs
