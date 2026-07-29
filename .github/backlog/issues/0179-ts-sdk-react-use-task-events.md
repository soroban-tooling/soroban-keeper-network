---
title: "feat(sdk-ts-react): useTaskEvents live-updates hook via getEvents polling"
labels: [enhancement, advanced]
epic: E12
wave: 3
depends_on: [0173, 0167]
---

## Summary

The polling hooks so far (0174, 0177, 0178) re-fetch a specific view on an interval. A task list wanting to show *new* task registrations as they happen needs the event-stream side instead, using the typed event decoders from issue 0167 and the pagination approach the keeper-bot example (and wave-2 issue 0038-style pagination) already established for `getEvents`.

## Expected behaviour

`useTaskEvents({ eventTypes?, pollIntervalMs? })` returning a growing, deduplicated list of decoded events matching the given types (defaulting to all), maintaining its own ledger cursor across polls (following the same cross-round cursor pattern the keeper-bot example uses) so it does not re-fetch and re-decode the same events repeatedly.

## Acceptance criteria

- [ ] Cursor advances correctly across polls, confirmed by a test that the same event is never delivered to the consumer twice.
- [ ] Filtering by event type works using the typed decoders from issue 0167, not ad hoc topic matching duplicated in this hook.
- [ ] Documents the tradeoff plainly: this is polling-based, not a true push subscription, since Soroban RPC has no equivalent the browser can use directly — set expectations correctly rather than implying real-time push.

## Files

- packages/sdk-ts/src/react/useTaskEvents.ts
