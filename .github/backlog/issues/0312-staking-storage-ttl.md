---
title: "fix(registry): ensure new staking storage keys are covered by instance TTL renewal"
labels: [contract, correctness, good-first-issue]
epic: E06
wave: 4
depends_on: [0289]
---

## Summary

The contract already had one archival-related incident (wave 1 issue 0015: instance storage was only ever TTL-bumped inside initialize, until every state-mutating call was made to call bump_instance). Every new staking entry point needs to call the same helper from its first version, not be discovered missing it after the fact the way the original bug was.

## Acceptance criteria

- [ ] Every state-mutating staking entry point calls bump_instance (for instance-scoped keys) and extends TTL appropriately for any persistent-scoped stake entries, mirroring credit_keeper's pattern for KeeperReward.
- [ ] A test advances the ledger far enough that an un-renewed entry would have archived, performs a staking action, advances further past the original window, and confirms the contract remains usable — the same test shape issue 0015's regression test used.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/ttl.rs
