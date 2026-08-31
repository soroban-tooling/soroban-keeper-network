---
title: "feat(ts-sdk): support the optional condition parameter and its rejection event"
labels: [ts-sdk, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0392, 0398]
---

## Summary

Updates the TypeScript SDK's register_task wrapper for the new condition parameter from issue 0392, and adds the ConditionNotMet event from issue 0398 to the SDK's typed event decoder alongside the existing event coverage.

## Acceptance criteria

- [ ] register_task's typed wrapper accepts the new optional parameter without breaking existing callers that omit it, if the SDK's own method signature can default it to undefined/None cleanly.
- [ ] The new event is added to the SDK's event decoder with correctly typed fields.
- [ ] A test registers a conditioned task and confirms the SDK correctly surfaces a rejected claim's event.

## Files

- ts-sdk/src/client.ts
- ts-sdk/src/events.ts
