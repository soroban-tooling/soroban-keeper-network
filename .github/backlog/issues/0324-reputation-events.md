---
title: "feat(registry): events for reputation updates"
labels: [contract, enhancement, good-first-issue]
epic: E07
wave: 4
depends_on: [0319]
---

## Summary

Following the project's convention that every state-relevant change is emitted, not just stored, this issue adds an event fired whenever a keeper's tracked reputation record changes, whether from a success or a missed window.

## Acceptance criteria

- [ ] An event carries the keeper address, the action that triggered the update, and the resulting score.
- [ ] README's event table is updated.
- [ ] A test confirms the event fires on both a success-driven and a failure-driven update.

## Files

- contracts/keeper-registry/src/events.rs
- README.md
