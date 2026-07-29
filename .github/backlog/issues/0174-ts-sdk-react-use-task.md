---
title: "feat(sdk-ts-react): useTask(taskId) hook with polling"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0173, 0163]
---

## Summary

The first data-fetching hook: a component showing one task's live state (status, reward, claimer) needs to re-poll as the underlying task changes, since Soroban views have no push-subscription mechanism a browser client can use directly.

## Expected behaviour

`useTask(taskId, { pollIntervalMs? })` returning `{ task, loading, error, refetch }`, polling `getTask` at the given interval (a sensible default, documented), pausing polling when the tab is backgrounded (via the Page Visibility API) to avoid wasting RPC calls on an unwatched tab, and stopping cleanly on unmount.

## Acceptance criteria

- [ ] Polling respects tab visibility.
- [ ] Cleans up its interval on unmount (test this explicitly — a leaked interval is a classic React-hook bug).
- [ ] `error` distinguishes `TaskNotFound` from a transient network failure, so a UI can show "this task doesn't exist" instead of "loading forever" for the former.

## Files

- packages/sdk-ts/src/react/useTask.ts
