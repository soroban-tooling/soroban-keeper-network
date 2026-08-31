---
title: "test(registry): confirm reputation-affecting entry points behave correctly before initialize"
labels: [testing, contract, good-first-issue]
epic: E07
wave: 4
depends_on: [0319, 0323]
---

## Summary

Since reputation updates happen inside claim_task and execute_task rather than through dedicated new entry points, this issue confirms those existing functions' NotInitialized behavior (established in wave 1 issue 0008) is unaffected by the reputation logic layered into them, and that the new eligibility-floor check (issue 0323) does not itself introduce a path that bypasses or duplicates the NotInitialized check.

## Acceptance criteria

- [ ] claim_task and execute_task still return NotInitialized correctly, unchanged from before this epic's reputation logic was added.
- [ ] The eligibility floor check in claim_task runs after, not instead of, the existing initialization and pause checks, so ordering does not surface the wrong error to a caller.

## Files

- contracts/keeper-registry/src/test/not_initialized.rs
