---
title: "feat(rust-sdk): a configurable retry policy for transient RPC failures"
labels: [rust-sdk, enhancement, intermediate]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The keeper-bot example (JavaScript) has a withRetry helper with exponential backoff and jitter for transient RPC errors, distinguishing them from deterministic contract errors that should never be retried (wave 1, issue 0031's neighboring work). A native Rust integration needs the same distinction: retrying a NotTaskClaimer error wastes a submission attempt that can never succeed, while retrying a genuine network timeout is correct.

## Expected behaviour

A RetryPolicy the client can be configured with, applied only around the RPC call itself, not around contract-level errors decoded from a successful response. The classification of what counts as transient (timeout, connection reset, simulation temporarily unavailable) versus permanent (any decoded KeeperError) should be explicit and overridable, not hardcoded, since a future contract error might need special-casing.

## Suggested approach

Port the reasoning from the JavaScript withRetry's isPermanentError function rather than reinventing the classification from scratch; the two implementations are solving the identical problem against the identical contract.

## Acceptance criteria

- [ ] Default policy retries only genuinely transient RPC-layer failures.
- [ ] Any decoded KeeperError is surfaced immediately, never retried.
- [ ] The policy is configurable (max attempts, base delay, jitter bounds) rather than a fixed constant.
- [ ] A test with a mock RPC layer confirms a simulated timeout is retried and a simulated LockPeriodActive response is not.

## Files

- rust-sdk/src/retry.rs
