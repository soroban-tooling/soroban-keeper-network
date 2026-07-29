---
title: "feat(sdk-ts): typed decoders for every contract event"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

The keeper-bot example hand-decodes `TaskRegistered` events with a fixed positional tuple unpack (`const [taskIdVal, , rewardVal, deadlineVal] = event.value.value()`), fragile to any change in event shape. This SDK should offer typed decoders for every event the contract emits, so both this SDK's own React hooks (epic E12's later issues) and any external consumer can decode events safely.

## Expected behaviour

One decoder per event (`decodeTaskRegistered`, `decodeTaskClaimed`, `decodeTaskExecuted`, and so on through every event in the README's event table), each returning a fully typed object, and a generic `decodeEvent(rawEvent)` that inspects the topic pair and dispatches to the right specific decoder, returning a discriminated union so a consumer can `switch` on event type with full type narrowing.

## Acceptance criteria

- [ ] Every event currently in README's event table has a corresponding typed decoder.
- [ ] The generic dispatcher correctly identifies event type from topics and returns the right shape.
- [ ] A malformed or unrecognized event is handled gracefully (returns `undefined` or a clearly-tagged "unknown" variant), not thrown as an uncaught exception, mirroring the keeper-bot's existing "skip malformed events" tolerance.
- [ ] Tests cover every event type plus at least one malformed input.

## Files

- packages/sdk-ts/src/events.ts
- packages/sdk-ts/src/events.test.ts
