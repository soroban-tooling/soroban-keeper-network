---
title: "feat(sdk-ts): client.cancelTask, covering both the Pending and lock-lapsed Claimed paths"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrapper for the owner's cancel call, which as of a recent contract change accepts both `Pending` tasks and `Claimed` tasks whose lock has lapsed (not just `Pending`, as an earlier version of the contract required) — the SDK should not encode the older, narrower assumption.

## Expected behaviour

`client.cancelTask({ owner, taskId })` with documentation (in the method's own doc comment, not just an external doc) stating both accepted preconditions, and a typed result that surfaces `LockPeriodActive` distinctly from `InvalidTaskStatus` for a rejected attempt on a still-locked `Claimed` task, since a caller can usefully retry after the lock lapses in the first case but not the second.

## Acceptance criteria

- [ ] Covers both accepted task states in its tests.
- [ ] `LockPeriodActive` and `InvalidTaskStatus` rejections are surfaced as distinct typed errors.

## Files

- packages/sdk-ts/src/methods/cancelTask.ts
