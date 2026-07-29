---
title: "perf(registry): re-tune INSTANCE_BUMP_THRESHOLD against real traffic assumptions"
labels: [contract, intermediate]
epic: E05
wave: 2
depends_on: []
---

## Summary

Wave 1's instance-TTL fix (issue 0015) picked INSTANCE_BUMP_THRESHOLD and INSTANCE_BUMP_LEDGERS as round numbers justified by rough ledger-time math, not by modeling actual expected traffic. This issue revisits those constants now that the contract has been live on testnet (per CHANGELOG's deployment entry) long enough to have real call-frequency data, if any is available, or otherwise documents the reasoning more rigorously.

## Expected behaviour

Either: confirm the existing constants are well-chosen against observed or realistically-modeled traffic patterns and document why, or propose adjusted values with justification. This is not expected to be a large change -- the existing values are probably fine -- but "probably fine" should become "verified fine" once real usage data exists.

## Acceptance criteria

- [ ] Current constants are evaluated against either real testnet traffic (if obtainable) or an explicit, stated traffic assumption.
- [ ] Any proposed change includes the same before/after resource-cost comparison discipline as issue 0111.
- [ ] If no change is warranted, that conclusion and its reasoning are added as a comment on the constants themselves, so the next person doesn't have to redo this analysis from scratch.

## Files

- contracts/keeper-registry/src/lib.rs
- docs/ARCHITECTURE.md
