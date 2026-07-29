---
title: "feat(sdk-ts-react): useIsClaimable convenience hook"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0173, 0163]
---

## Summary

A small, focused hook wrapping `client.isClaimable`, useful for a task-list UI wanting to visually distinguish claimable tasks (e.g. graying out or hiding ones a keeper cannot currently act on) without each list item independently polling the full `getTask`.

## Expected behaviour

`useIsClaimable(taskId, { pollIntervalMs? })` returning a boolean plus loading/error state, following the same polling-and-visibility conventions as `useTask` (issue 0174) but with a lighter payload since it only needs the one boolean the contract's own view already computes.

## Acceptance criteria

- [ ] Reuses the polling/visibility logic from `useTask` rather than reimplementing it — extract a shared internal polling helper if this is the second hook needing it (it is).
- [ ] Test confirms correct boolean tracking across a claim/lock-lapse cycle.

## Files

- packages/sdk-ts/src/react/useIsClaimable.ts
- packages/sdk-ts/src/react/usePolling.ts
