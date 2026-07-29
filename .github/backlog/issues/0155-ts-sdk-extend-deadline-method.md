---
title: "feat(sdk-ts): client.extendDeadline"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrapper for the owner's deadline-extension call.

## Expected behaviour

`client.extendDeadline({ owner, taskId, newDeadline })`, typed with `newDeadline` as a `Date` or Unix-seconds `number` (pick one and be consistent with the rest of the SDK's date handling — see issue 0165's cross-cutting date-type decision, and coordinate rather than deciding independently here).

## Acceptance criteria

- [ ] Consistent date/timestamp typing with the rest of the SDK (do not merge this ahead of the date-handling decision without checking it first).
- [ ] Test covers a successful extension.

## Files

- packages/sdk-ts/src/methods/extendDeadline.ts
