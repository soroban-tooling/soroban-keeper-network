---
title: "test(property): governance tallying and quorum evaluation is correct under randomized voting patterns"
labels: [testing, contract, advanced]
epic: E09
wave: 4
depends_on: [0364, 0365]
---

## Summary

A property test generating randomized voter populations, voting-power distributions, and vote choices, confirming the tally, quorum, and passing evaluation from issues 0364 and 0365 always agree with an independent reference computation.

## Acceptance criteria

- [ ] The property covers a wide range of participation rates and vote splits, including exact-boundary quorum and passing-threshold cases.
- [ ] Weighted voting power (if issue 0360 specified something other than one-token-one-vote) is included in the generated scenarios, not just the simple case.

## Files

- contracts/governance/src/test.rs
