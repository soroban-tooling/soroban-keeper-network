---
title: "feat(sdk-ts): client.withdrawRewards"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrapper for a keeper's balance withdrawal, notable mainly for returning a value (the withdrawn amount) that the contract itself returns from the call — the SDK should surface that return value typed as the equivalent of the contract's `i128`, which needs a documented decision on how large integers are represented in TypeScript (see issue 0165's cross-cutting numeric-type decision).

## Expected behaviour

`client.withdrawRewards({ keeper })` returning the withdrawn amount using whatever numeric type issue 0165 settles on (likely `bigint`, given `i128` can exceed `Number.MAX_SAFE_INTEGER`), and rejecting `NoRewardsAvailable` as a typed, expected outcome (a keeper bot checking its balance before withdrawing should treat this as a normal "nothing to do" case, not an exceptional error to log loudly).

## Acceptance criteria

- [ ] Return type matches the SDK's chosen large-integer convention.
- [ ] `NoRewardsAvailable` is typed distinctly enough that callers can handle it without string-matching an error message.

## Files

- packages/sdk-ts/src/methods/withdrawRewards.ts
