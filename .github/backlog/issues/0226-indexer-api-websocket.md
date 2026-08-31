---
title: "feat(indexer): a WebSocket feed for live event subscriptions"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0225]
---

## Summary

The REST API from issue 0225 answers point-in-time queries; a dashboard showing live activity (new tasks appearing, a leaderboard updating) needs a push mechanism rather than polling the REST API on an interval.

## Expected behaviour

A WebSocket endpoint a client subscribes to, optionally filtered by event type or by address (owner or keeper), that pushes each newly ingested event as it is stored, in the same typed shape the REST API's event feed uses.

## Suggested approach

Reuse the REST API's event types directly rather than defining a parallel WebSocket-specific payload shape; a client that already knows how to parse a REST event response should not need a second parser for the live feed.

## Acceptance criteria

- [ ] A client can subscribe filtered by event type, by address, or both.
- [ ] Pushed events match the REST API's event shape exactly.
- [ ] A disconnected client that reconnects can request events since a given cursor, so a brief network interruption does not silently lose events for the consumer.
- [ ] Load-tested with a reasonable number of concurrent subscribers to confirm the fan-out approach does not require a database query per event per subscriber.

## Files

- indexer/src/api/websocket.rs
