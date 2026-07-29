---
title: "feat(sdk-ts): client.expireTask"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrapper for the permissionless deadline-enforcement call. Simple relative to its neighbors since it takes no owner/keeper argument at all — worth calling out explicitly in the method's typing so a caller doesn't need to look up who is allowed to call it.

## Expected behaviour

`client.expireTask({ taskId, caller })` where `caller` is only the transaction source account (needed to build and submit the transaction) and is documented as not requiring any specific authorization relationship to the task, distinct from every other mutating method in this SDK.

## Acceptance criteria

- [ ] Method doc comment states plainly that any account may call this.
- [ ] Test confirms a caller unrelated to the task's owner or claimer can successfully expire it past its deadline.

## Files

- packages/sdk-ts/src/methods/expireTask.ts
