---
title: "test(property): extend the solvency and single-payout properties to cover batch_register_tasks"
labels: [testing, contract, advanced]
epic: E05
wave: 2
depends_on: [0098, 0054, 0056]
---

## Summary

Epic E03 built solvency (issue 0054) and single-payout (issue 0056) property tests against the pre-batch contract. This issue extends them (or the shared model-checking harness from issue 0061, if ready) to cover batch registration, so the two epics' work is proven compatible.

## Expected behaviour

The solvency property continues to hold when task creation happens via batch_register_tasks as well as individual register_task calls, in arbitrary mixed sequences. Separately, a property specific to batching: after a rejected batch (whether due to invalid parameters or the max_total_reward ceiling), the owner's token balance and the registry's total escrow are both provably unchanged -- not just "no task was created," but "no partial transfer happened either."

## Acceptance criteria

- [ ] Solvency property covers mixed single and batch registration.
- [ ] A dedicated property confirms zero token movement on any rejected batch, across a range of rejection reasons (invalid single entry, ceiling exceeded, resource limit).
- [ ] References I-1 and the batch-specific all-or-nothing guarantee from issue 0097's design.

## Files

- contracts/keeper-registry/src/test.rs or contracts/keeper-registry/tests/model.rs
