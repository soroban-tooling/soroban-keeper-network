---
title: "test(fuzz): fuzz interactions between the parameter-validation bounds and the verifier path together"
labels: [testing, contract, advanced]
epic: E03
wave: 2
depends_on: [0064, 0074]
---

## Summary

Most of this wave's fuzzing issues target one feature area at a time (parameter bounds, or the verifier path, in isolation). Real usage combines them -- a task registered near the lock/ttl boundary that also has a verifier attached. This issue specifically fuzzes the combination, since interaction bugs between two independently-correct features are exactly the class of bug single-feature fuzzing structurally cannot find.

## Expected behaviour

A fuzz target that generates register_task calls with both the lock/ttl/calldata parameters (from issue 0064's rejection-surface work) and a verifier attachment (from issue 0073) fuzzed together, then drives the resulting task through claim/execute with a fuzzed verifier response, confirming no combination causes a panic or an inconsistent state (e.g. a task rejected at registration for bad parameters should never have escrowed any funds, regardless of what verifier was or wasn't attached).

## Acceptance criteria

- [ ] Covers the full cross product space at least at the boundaries of each individual dimension (not exhaustively, but not only "normal" values either).
- [ ] Confirms zero escrow movement for any rejected registration, regardless of verifier presence.
- [ ] This issue should be picked up after both issue 0064 and issue 0074 have landed -- it is explicitly an integration fuzz target, not a substitute for either's own focused coverage.

## Files

- fuzz/fuzz_targets/register_and_verify_combined.rs
