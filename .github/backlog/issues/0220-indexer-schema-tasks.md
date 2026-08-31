---
title: "feat(indexer): schema and ingestion for task lifecycle events"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0219]
---

## Summary

Implements storage and ingestion for the six task-lifecycle events: TaskRegistered, TaskClaimed, TaskExecuted, TaskExpired, TaskCancelled, and RewardIncreased and DeadlineExtended if issue 0218's schema groups those two here rather than separately.

## Expected behaviour

A tasks table (or equivalent) that a consumer can query by task id and get the task's full observed history, and a current-state view derived from that history (status, current reward, current deadline) rather than trusting any single event as the whole truth — a task's current reward, for instance, is only correct after folding in every RewardIncreased since registration.

## Suggested approach

Do not attempt to reconstruct fields the events do not carry. TaskClaimed does not include the task's reward; if a query needs both the claim and the reward together, join against the TaskRegistered row rather than inventing a value.

## Acceptance criteria

- [ ] All six task-lifecycle events are ingested with their exact payload fields.
- [ ] A query for a single task id returns its full event history in chronological order.
- [ ] A derived current-state query correctly folds RewardIncreased and DeadlineExtended into a task's live reward and deadline.
- [ ] A test replays a fixed sequence of events for one task id and asserts the derived state matches what the contract itself would report via get_task.

## Files

- indexer/src/schema/tasks.sql (or equivalent)
- indexer/src/ingest/tasks.rs
