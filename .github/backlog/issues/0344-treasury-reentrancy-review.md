---
title: "security(treasury): checks-effects-interactions review of the distribution path"
labels: [contract, security, advanced]
epic: E08
wave: 4
depends_on: [0340]
---

## Summary

Following the same discipline required of every fund-moving function across this project (the CEI fixes in wave 1 issues 0002 and 0003, and the explicit review required of staking in epic E06 issue 0295), the treasury's distribute function needs a CEI review before merge, especially since it may call out to multiple recipient addresses in one invocation, multiplying the reentrancy surface relative to a single-recipient transfer.

## Expected behaviour

Any internal accounting state distribute updates is written before any external transfer occurs, and a reentrant call during one recipient's transfer cannot cause a double-distribution of the same swept amount.

## Acceptance criteria

- [ ] The distribution function's ordering is verified by reading the actual code, not assumed.
- [ ] A reentrancy regression test using a malicious recipient contract that attempts to re-enter distribute mid-transfer, following the same pattern as the registry's existing reentrant-token tests.
- [ ] Findings are fixed before this issue closes.

## Files

- contracts/treasury/src/lib.rs
- contracts/treasury/src/test.rs
