---
title: "feat(registry): emit an event when a condition rejects a claim attempt"
labels: [contract, enhancement, good-first-issue]
epic: E10
wave: 4
depends_on: [0393]
---

## Summary

Following the project's established convention, a condition-driven claim rejection is informative enough to a keeper bot deciding whether to retry later that it should be observable as an event, not just a returned error on the failed transaction.

## Acceptance criteria

- [ ] A ConditionNotMet event (or similar) fires on a rejected claim attempt, carrying the task id and the condition address.
- [ ] README's event table is updated.
- [ ] A test confirms the event fires exactly on the false-condition rejection path and not on any other claim_task rejection.

## Files

- contracts/keeper-registry/src/events.rs
- README.md
