---
title: "fix(registry): ensure reputation storage is covered by TTL renewal"
labels: [contract, correctness, good-first-issue]
epic: E07
wave: 4
depends_on: [0319]
---

## Summary

Following the same discipline required of staking storage in issue 0312, this issue confirms the reputation record's storage entry is renewed on every write via bump_instance or the equivalent persistent-entry extend_ttl call, so it cannot silently archive the way instance storage once could before wave 1 issue 0015 fixed the original gap.

## Acceptance criteria

- [ ] Every write to a keeper's reputation record renews its storage TTL appropriately.
- [ ] A test advances the ledger past what the original un-renewed window would have allowed, updates reputation, advances further, and confirms the record remains accessible.

## Files

- contracts/keeper-registry/src/reputation.rs
- contracts/keeper-registry/src/test/ttl.rs
