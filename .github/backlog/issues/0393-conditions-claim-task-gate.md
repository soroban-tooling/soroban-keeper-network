---
title: "feat(registry): claim_task evaluates the attached condition before allowing a claim"
labels: [contract, enhancement, advanced]
epic: E10
wave: 4
depends_on: [0390, 0392]
---

## Summary

Implements the core behavior of this epic: when a task carries a condition, claim_task calls it and only proceeds if it returns true, per issue 0390's decision that a false condition leaves the task Pending and unclaimed rather than producing any other outcome.

## Expected behaviour

If task.condition is None, claim_task behaves exactly as today with no added cost. If Some(addr), claim_task constructs a client for addr using the interface issue 0390 specified and calls it with the task; if it returns false, claim_task rejects with a new typed error and the task remains Pending, retryable by the same or a different keeper once the condition later becomes true.

## Acceptance criteria

- [ ] The None path is provably unchanged — every existing test for claim_task passes without modification beyond the mechanical None argument addition.
- [ ] The Some path with an always-true condition behaves identically to the None path from that point forward.
- [ ] The Some path with an always-false condition rejects without mutating task state, verified by confirming the task is still Pending and unclaimed afterward.

## Files

- contracts/keeper-registry/src/task.rs
- contracts/keeper-registry/src/test/claim.rs
