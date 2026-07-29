---
title: "feat(sdk-ts): client.claimTask"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrapper for the permissionless keeper-claim call, the first of the keeper-facing (as opposed to owner-facing) methods this epic covers.

## Expected behaviour

`client.claimTask({ keeper, taskId })`, returning a typed success/failure result that surfaces `LockPeriodActive` and `DeadlinePassed` distinctly (per issue 0166's error-decoding work) rather than a generic thrown error, since a keeper bot built on this SDK needs to tell "someone else got there first, keep scanning" apart from "this task is dead, stop trying."

## Acceptance criteria

- [ ] Typed result distinguishes success from the specific documented failure modes.
- [ ] Test covers a successful claim and a `LockPeriodActive` rejection.

## Files

- packages/sdk-ts/src/methods/claimTask.ts
