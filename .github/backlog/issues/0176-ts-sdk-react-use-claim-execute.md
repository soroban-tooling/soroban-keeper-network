---
title: "feat(sdk-ts-react): useClaimTask and useExecuteTask mutation hooks"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0173, 0156, 0157]
---

## Summary

The keeper-facing counterparts to issue 0175's owner-facing mutation hook, following the same idle/pending/success/error shape for consistency across the hook library.

## Expected behaviour

`useClaimTask()` and `useExecuteTask()`, mirroring `useRegisterTask`'s state machine exactly, with `useExecuteTask` accepting the same flexible proof input types as the underlying `client.executeTask` (issue 0157).

## Acceptance criteria

- [ ] Both hooks follow the exact same state-machine shape as `useRegisterTask`, for consistency across the library (a consumer should be able to learn the pattern once).
- [ ] Tests cover success and the keeper-specific rejections (`LockPeriodActive`, `NotTaskClaimer`) as distinct error states.

## Files

- packages/sdk-ts/src/react/useClaimTask.ts
- packages/sdk-ts/src/react/useExecuteTask.ts
