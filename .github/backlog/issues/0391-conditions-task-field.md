---
title: "feat(registry): add an optional condition field to Task"
labels: [contract, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0390]
---

## Summary

Implements the first concrete piece of issue 0390's design: an optional condition: Option<Address> field on Task, unused by any logic yet, following the exact same incremental-and-reviewable approach epic E04's issue 0072 used for its own (never-implemented) verifier field.

## Acceptance criteria

- [ ] Task.condition: Option<Address> is added.
- [ ] Every existing constructor of Task sets it to None until issue 0392 adds a way to set it otherwise.
- [ ] Confirm and document the schema-evolution question for already-persisted Task entries, the same check issue 0072 required, rather than assuming it is safe without verifying against the actual soroban-sdk version in use.

## Files

- contracts/keeper-registry/src/types.rs
- contracts/keeper-registry/src/test/register.rs
