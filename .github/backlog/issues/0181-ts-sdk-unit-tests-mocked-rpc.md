---
title: "test(sdk-ts): unit test suite with a hand-written fake RPC server"
labels: [testing, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Complementing issue 0180's real-network integration suite with a fast, deterministic unit-test layer using a fake RPC server, following the same "hand-written fake, not a mocking-framework mock" philosophy the wave-2 keeper-bot test suite work used — but this time, learn from that suite's mistakes: any fake response shape must be verified against real `@stellar/stellar-sdk` decode functions (`scValToNative` etc.), not hand-rolled objects with method names the fake author assumed existed.

## Expected behaviour

A `FakeRpcServer` implementing the subset of the Soroban RPC interface this SDK actually calls, returning real, correctly-encoded `ScVal` responses (constructed via `nativeToScVal`, not fabricated objects), used across the unit tests for every method in this epic.

## Acceptance criteria

- [ ] The fake's responses are round-tripped through real SDK encode/decode functions, not hand-constructed to match what the code under test happens to expect — verify this by confirming the fake would also work correctly if fed into a completely independent decode path.
- [ ] Shared across all method unit tests in this package, not duplicated per test file.
- [ ] A comment explicitly warns future contributors against the exact mistake this issue is designed to avoid, with a concrete note that this bit a sibling test suite in wave 2 (bot test PR #128).

## Files

- packages/sdk-ts/src/testing/fakeRpc.ts
