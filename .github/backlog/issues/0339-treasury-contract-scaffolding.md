---
title: "chore(treasury): scaffold the treasury contract"
labels: [contract, tooling, intermediate]
epic: E08
wave: 4
depends_on: [0338]
---

## Summary

If issue 0338 chose a separate treasury contract, this stands it up as a deployable, empty contract with no distribution logic yet, following the same scaffold-before-logic discipline used across every other epic (issue 0051's fuzz harness, issue 0219's indexer, issue 0251's bot v2).

## Acceptance criteria

- [ ] The contract builds, deploys to a local network, and exposes a version view following the registry's own VERSION convention.
- [ ] If issue 0338 instead chose in-registry routing, this issue is a no-op; close it noting that and proceed directly to issue 0340 against the registry's own source.

## Files

- contracts/treasury/src/lib.rs (if applicable)
