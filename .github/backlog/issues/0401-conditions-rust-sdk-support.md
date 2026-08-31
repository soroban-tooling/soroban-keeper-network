---
title: "feat(rust-sdk): support the optional condition parameter and its rejection event"
labels: [rust-sdk, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0392, 0398, 0199, 0208]
---

## Summary

Extends the Rust SDK's register_task wrapper (issue 0199) and event decoder (issue 0208) for the new condition parameter and ConditionNotMet event, matching issue 0400's TypeScript coverage.

## Acceptance criteria

- [ ] register_task's wrapper accepts the new optional parameter.
- [ ] The event decoder covers ConditionNotMet with correctly typed fields.
- [ ] A test mirrors issue 0400's scenario.

## Files

- rust-sdk/src/client.rs
- rust-sdk/src/events.rs
