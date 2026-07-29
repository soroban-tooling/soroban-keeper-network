---
title: "test(registry): pin the empirically-measured batch size ceiling from issue 0097"
labels: [testing, contract, intermediate]
epic: E05
wave: 2
depends_on: [0098, 0097]
---

## Summary

Issue 0097 asked for an empirical measurement of how many tasks one batch_register_tasks call can hold before hitting Soroban's per-transaction resource budget. This issue turns that one-time measurement into a permanent regression test, so a future change that makes each task registration more expensive (e.g. a larger Task struct, per issue 0072's verifier field) is caught by CI rather than discovered by a keeper bot's transaction failing in production.

## Expected behaviour

A test that registers a batch at the measured practical ceiling from 0097 and confirms it still succeeds within budget. If it starts failing, that is the intended signal that something increased the per-task resource cost enough to shrink the effective ceiling, and the batch API's documented guidance (or the ceiling itself) needs revisiting.

## Acceptance criteria

- [ ] Test uses the actual number 0097 measured, not a guess.
- [ ] Test fails clearly (not with an opaque resource-exhaustion error) if the ceiling has silently shrunk, ideally by asserting on the resource budget consumed rather than just on success/failure.
- [ ] Documented in a comment why this specific number was chosen.

## Files

- contracts/keeper-registry/src/test.rs
