---
title: "feat(registry): document and bound the resource cost of a condition check"
labels: [contract, security, intermediate]
epic: E10
wave: 4
depends_on: [0393, 0395]
---

## Summary

Mirrors epic E04's issue 0076 for this epic: the cross-contract call to a task's condition is charged against the claiming keeper's transaction budget, and an expensive condition could make claiming a task cost far more than the keeper anticipated, this time affecting every claim attempt rather than only successful executions.

## Acceptance criteria

- [ ] Documents plainly who bears the condition's resource cost and confirms whether a keeper can estimate it before submitting a claim (via simulation) or only discovers it after attempting one.
- [ ] Investigates whether Soroban exposes any way to cap a sub-call's resource consumption from the caller's side; if so, apply it, if not, document the limitation clearly.
- [ ] Feeds a clear requirement into any keeper-bot-side task-selection logic (epic E15) that would need to factor this in.

## Files

- contracts/keeper-registry/src/task.rs
- docs/TASK_CONDITIONS_DESIGN.md
