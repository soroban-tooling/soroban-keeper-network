---
title: "feat(indexer): schema and ingestion for keeper-facing events"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0219]
---

## Summary

Implements storage and ingestion for RewardsWithdrawn and the keeper-address field already present on TaskClaimed and TaskExecuted, so a consumer can answer "what has this keeper address done" without scanning the full task-events table and filtering client-side.

## Expected behaviour

A keeper-indexed view: for a given address, every task it has claimed, every task it has executed, the net reward from each, and every withdrawal it has made, with a running total distinguishing credited-but-unwithdrawn balance from already-withdrawn amounts.

## Suggested approach

The running credited balance is derivable from TaskExecuted's net_reward field summed per keeper, minus RewardsWithdrawn's amount summed per keeper. This should match the contract's own keeper_balance view at any point the indexer is fully caught up; that agreement is the natural correctness check for this issue.

## Acceptance criteria

- [ ] Querying by keeper address returns claims, executions, and withdrawals for that address.
- [ ] The derived credited-balance figure is exposed as its own field, not left for every consumer to recompute independently.
- [ ] A test executes several tasks for one keeper, withdraws partway through, and confirms the indexer's derived balance matches the contract's keeper_balance at each step.

## Files

- indexer/src/schema/keepers.sql
- indexer/src/ingest/keepers.rs
