---
title: "feat(registry): enforce max_total_reward ceiling on batch_register_tasks"
labels: [contract, security, intermediate]
epic: E05
wave: 2
depends_on: [0098]
---

## Summary

Issue 0097's design doc flagged the risk of an owner authorizing a batch call and having it silently escrow more than expected if the batch contents change between when the owner reviewed the transaction and when it lands. This issue adds the max_total_reward ceiling 0097 proposed as the mitigation, if 0098's implementation did not already include it.

## Expected behaviour

batch_register_tasks takes an additional max_total_reward: i128 parameter. Before any escrow transfer happens, the sum of all entries' reward fields is computed and compared against this ceiling; if the sum exceeds it, the whole call is rejected with a typed error and no transfers occur.

## Acceptance criteria

- [ ] The sum of rewards across the batch is validated against max_total_reward before any transfer.
- [ ] A test confirms a batch whose entries sum above the ceiling is rejected entirely, with zero transfers.
- [ ] A test confirms a batch at or under the ceiling succeeds normally.

## Files

- contracts/keeper-registry/src/lib.rs
- contracts/keeper-registry/src/test.rs
