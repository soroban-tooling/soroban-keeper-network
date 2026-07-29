---
title: "feat(sdk-ts-react): useRegisterTask mutation hook"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0173, 0154]
---

## Summary

A mutation-style hook (following the increasingly standard shape popularized by data-fetching libraries: an idle/pending/success/error state machine around a single imperative action) wrapping `client.registerTask`.

## Expected behaviour

`useRegisterTask()` returning `{ registerTask: (params) => Promise<taskId>, status, error, reset }`, where `status` transitions `idle -> pending -> success | error`, suitable for driving a submit-button's disabled/loading state directly.

## Acceptance criteria

- [ ] State machine transitions are tested for both the success and error paths.
- [ ] `reset()` returns to `idle`, allowing a form to be resubmitted after a prior error without a full remount.

## Files

- packages/sdk-ts/src/react/useRegisterTask.ts
