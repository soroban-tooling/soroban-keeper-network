---
title: "feat(registry): implement the reputation decay function"
labels: [contract, enhancement, intermediate]
epic: E07
wave: 4
depends_on: [0318, 0319]
---

## Summary

If issue 0318 specified that reputation decays over time so old history matters less than recent activity, this issue implements that function.

## Suggested approach

An on-chain decay computed lazily at read time (based on ledgers elapsed since the last update) is almost certainly preferable to a scheme requiring an active transaction to apply decay to every keeper periodically, since the latter has no natural trigger and would require someone to pay for it. Confirm this is what issue 0318 specified; if not, implement whatever it actually specified rather than substituting this approach silently.

## Acceptance criteria

- [ ] Decay is computed correctly according to issue 0318's function.
- [ ] A test confirms a keeper's effective (decayed) reputation at various elapsed-ledger points matches the documented formula exactly, including boundary ledgers.
- [ ] If decay is lazy/read-time, confirm it does not require a state-mutating call to apply, and confirm two different callers reading at the same ledger get the same answer regardless of when either last interacted with the contract.

## Files

- contracts/keeper-registry/src/reputation.rs
- contracts/keeper-registry/src/test/reputation.rs
