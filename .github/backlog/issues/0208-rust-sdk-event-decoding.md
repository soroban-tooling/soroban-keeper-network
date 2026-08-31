---
title: "feat(rust-sdk): typed decoders for every emitted event"
labels: [rust-sdk, enhancement, intermediate]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The registry emits fifteen distinct events, each a two-symbol topic pair with a typed payload (see events.rs). A native Rust integration reading transaction results or a ledger stream needs typed decoders for these the same way the TypeScript SDK does, rather than every consumer hand-rolling XDR decoding against the topic list.

## Expected behaviour

One enum, RegistryEvent, with a variant per event (TaskRegistered, TaskClaimed, TaskExecuted, TaskExpired, TaskCancelled, RewardsWithdrawn, Paused, FeeUpdated, AdminTransferred, RewardIncreased, DeadlineExtended, MinRewardUpdated, FeesSwept, Initialized, Upgraded), each carrying its actual payload fields with the exact types events.rs defines. A single decode function takes the raw topic/data pair from a transaction result and returns Option<RegistryEvent>, none if the topics don't match a known registry event.

## Suggested approach

Match the topic pairs literally against the symbol_short! values events.rs actually publishes, e.g. ("reg", "task") for TaskRegistered, ("wdraw", "reward") for RewardsWithdrawn. Do not guess at topic strings; read them from the current events.rs rather than from an older design document, since the two can drift.

## Acceptance criteria

- [ ] All fifteen events have a variant with correctly typed fields.
- [ ] The decoder returns None for topics from a different contract or an unrecognized pair, never panics.
- [ ] A test constructs a transaction result containing one of each event type against a real registry call and confirms the decoder recovers the exact original values.
- [ ] Rustdoc on RegistryEvent links to the README event table as the source of truth rather than duplicating it.

## Files

- rust-sdk/src/events.rs
- rust-sdk/tests/events.rs
