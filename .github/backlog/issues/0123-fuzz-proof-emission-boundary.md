---
title: "test(fuzz): fuzz execute_task's proof-length boundary against MAX_PROOF_LEN precisely"
labels: [testing, contract, good-first-issue]
epic: E03
wave: 2
depends_on: [0053]
---

## Summary

Issue 0053 already fuzzes execute_task broadly including proof size. This issue is a narrower, boundary-focused companion mirroring the calldata-boundary approach from issue 0119, specifically for MAX_PROOF_LEN, since wave 1's issue 4/PR shipped proof emission and bounding after epic E03's broader fuzz issues were originally scoped.

## Expected behaviour

A fuzz target (or an extension of 0053's target, if that has not been implemented yet -- check before duplicating effort) that generates proof lengths weighted around MAX_PROOF_LEN and confirms the exact boundary behavior: accepted at and under the limit, rejected with ProofTooLarge specifically over it, and the accepted proof is faithfully emitted in the TaskExecuted event at every length up to the limit (not just at one arbitrary accepted length).

## Acceptance criteria

- [ ] Boundary precisely covered (MAX_PROOF_LEN - 1, exactly, + 1 at minimum, plus randomized values further out).
- [ ] Confirms the emitted event's proof field matches the input exactly at multiple accepted lengths, not just presence/absence.
- [ ] Coordinates with issue 0053 to avoid duplicating an existing target -- extend it if it exists, add a new one only if that target has not been built yet.

## Files

- fuzz/fuzz_targets/execute_task.rs (or a new proof_boundary.rs)
