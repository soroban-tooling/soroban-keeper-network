---
title: "feat(keeper-bot-v2): source candidate tasks from the indexer instead of raw event scans"
labels: [keeper-bot, indexer, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1's fetchPendingTasks queries getEvents directly against the RPC node, bounded to a lookback window. Once epic E14's indexer exists with a REST and WebSocket API (issues 0225, 0226), a keeper bot can subscribe to newly registered tasks directly rather than re-scanning event windows itself, avoiding both the lookback-window edge cases v1's cursor tracking (issue 0135) worked around and duplicated RPC load across every keeper running the older approach.

## Expected behaviour

An indexer-backed task source using the WebSocket feed for new TaskRegistered events and the REST API to check current claimability (is_claimable is still authoritative on-chain, so this does not remove the need for the pre-claim check from wave 1's issue 0034, only changes how candidates are discovered), with a fallback to direct RPC scanning if no indexer endpoint is configured, so v2 does not hard-require an indexer deployment to run standalone.

## Acceptance criteria

- [ ] With an indexer configured, new tasks are discovered via its WebSocket feed rather than direct getEvents polling.
- [ ] Without an indexer configured, the bot falls back to direct scanning and continues to function.
- [ ] is_claimable is still checked on-chain before claiming regardless of task source, since indexed data can lag by the time issue 0231 exists to measure.

## Files

- (v2 package)/src/task_source.*
