---
title: "feat(registry): is_claimable reflects the attached condition"
labels: [contract, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0393]
---

## Summary

is_claimable exists specifically so a keeper bot can pre-filter candidates without simulating a full claim_task call (per its own doc comment). Once conditions exist, is_claimable needs to evaluate them too, or a keeper bot relying on it would attempt claims that are guaranteed to fail against a false condition.

## Acceptance criteria

- [ ] is_claimable returns false for a task whose attached condition currently evaluates false, in addition to its existing status and lock-window checks.
- [ ] A test confirms is_claimable and claim_task agree on every combination of status, lock state, and condition result — the same consistency check that matters for any pre-flight view mirroring a mutating function's guard logic.
- [ ] Since is_claimable is a view and must stay side-effect-free, confirm the condition call itself does not require a transaction to evaluate (it should be a plain cross-contract read, not one that only works when submitted).

## Files

- contracts/keeper-registry/src/views.rs
- contracts/keeper-registry/src/test/claim.rs
