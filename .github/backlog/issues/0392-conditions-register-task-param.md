---
title: "feat(registry): register_task accepts an optional condition address"
labels: [contract, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0391]
---

## Summary

Extends register_task with an additional parameter, condition: Option<Address>, following the same additive-ABI-change discipline epic E04's issue 0073 established for its own unimplemented verifier parameter — updating every existing call site in the same change.

## Acceptance criteria

- [ ] register_task accepts the new parameter; None behaves exactly as today.
- [ ] Every call site across the repository (tests, README examples, batch_register_tasks's BatchTaskParams if issue 0390 specifies batch registration should support conditions too) is updated to the new arity.
- [ ] CHANGELOG entry noting the breaking ABI change, following issue 0096's precedent.

## Files

- contracts/keeper-registry/src/task.rs
- contracts/keeper-registry/src/test/register.rs
- README.md
- CHANGELOG.md
