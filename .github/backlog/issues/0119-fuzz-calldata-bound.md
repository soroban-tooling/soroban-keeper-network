---
title: "test(fuzz): fuzz register_task's calldata bound now that CalldataTooLarge exists"
labels: [testing, contract, good-first-issue]
epic: E03
wave: 2
depends_on: [0051]
---

## Summary

Wave 1's issue 0007 shipped MAX_CALLDATA_LEN and KeeperError::CalldataTooLarge after epic E03's original fuzz-target issues (0052, 0064) were drafted against an earlier version of main that did not yet have this bound. This issue closes that gap: a fuzz target specifically exercising the calldata-length boundary, mirroring the rejection-surface approach issue 0064 already took for lock_ledgers/ttl_ledgers.

## Expected behaviour

A fuzz target generating calldata length weighted toward the MAX_CALLDATA_LEN boundary (just under, exactly at, just over, and far over) and asserting: every length at or under the limit is accepted (given other parameters are valid), every length over it is rejected with exactly CalldataTooLarge, and no length causes a panic.

## Acceptance criteria

- [ ] Covers the boundary precisely, not just large-vs-small.
- [ ] Confirms CalldataTooLarge specifically, not just "some error."
- [ ] Seeded per issue 0067's convention with MAX_CALLDATA_LEN, MAX_CALLDATA_LEN - 1, and MAX_CALLDATA_LEN + 1.

## Files

- fuzz/fuzz_targets/register_task_calldata_bound.rs
