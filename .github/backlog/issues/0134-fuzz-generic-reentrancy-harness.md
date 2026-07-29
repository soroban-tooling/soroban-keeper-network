---
title: "test(fuzz): generalize the hand-written reentrant-token pattern into a reusable fuzz-friendly mock"
labels: [testing, contract, advanced]
epic: E03
wave: 2
depends_on: [0051, 0056]
---

## Summary

Wave 1's CEI-ordering fixes (cancel_task, expire_task) each hand-wrote a bespoke reentrant mock token contract inside test.rs to prove a specific reentrancy scenario. Issue 0056 (single-payout property test) already calls for reusing this pattern across payout paths. This issue goes further: build one configurable reentrant-token mock, usable both by hand-written tests and by a fuzz target, where *which* function it re-enters and *when* (before/after its own balance update) are configuration rather than separate copy-pasted contracts.

## Expected behaviour

A single ReentrantToken-style contract (published somewhere shared, not duplicated per test file) configurable with: which registry function to re-call, with what arguments, and at what point in its own transfer implementation. A fuzz target can then randomize which registry function is being reentered into, across all the payout paths at once, rather than needing a bespoke target per function.

## Suggested approach

This is a meaningful refactor of existing wave-1 test code, not just new code -- coordinate with whether those tests have already been consolidated by issue 0068's shared invariant-checker work, since the two refactors touch adjacent code and ordering them sensibly (one, then the other, not simultaneously) will make each easier to review.

## Acceptance criteria

- [ ] One configurable reentrant-token mock replaces the bespoke ones in the cancel_task and expire_task CEI test files, with no loss of the specific scenarios those tests already prove.
- [ ] A fuzz target randomizes which function is targeted for reentrancy, using this shared mock.
- [ ] Existing hand-written CEI regression tests still pass, now built on the shared mock.

## Files

- contracts/keeper-registry/src/test.rs
- fuzz/fuzz_targets/reentrancy.rs
