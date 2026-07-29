---
title: "feat(sdk-ts): read-only view methods -- getTask, taskCount, keeperBalance, isClaimable"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

The task-and-keeper-facing read-only views, grouped since they share the free-simulation call path already established by `client`'s shared plumbing (issue 0153).

## Expected behaviour

`client.getTask(taskId)` returning a fully typed `Task` object (status as a proper enum, `claimer`/`claimLedger` as `undefined` rather than a Soroban-specific `Option` representation the caller has to unwrap manually), `client.taskCount()`, `client.keeperBalance(address)`, and `client.isClaimable(taskId)`. `getTask` on a nonexistent id should reject with a typed `TaskNotFound`, not return `null` silently — a caller should not be able to mistake "task does not exist" for "task exists and every field is falsy."

## Acceptance criteria

- [ ] `Task`'s TypeScript type fully matches the contract struct, field for field, kept in sync per issue 0192's versioning policy.
- [ ] `getTask` on a missing id throws/rejects distinctly rather than returning a nullish value.
- [ ] All four methods covered by tests against both existing and nonexistent/zero-value cases.

## Files

- packages/sdk-ts/src/methods/views.ts
