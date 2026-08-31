---
title: "feat(indexer): expose ingestion lag as a monitorable metric"
labels: [indexer, observability, good-first-issue]
epic: E14
wave: 3
depends_on: [0219]
---

## Summary

A consumer relying on the indexer for near-real-time data needs to know how far behind the chain it currently is. Without a lag metric, a stalled indexer looks identical to a healthy but quiet one from the outside.

## Expected behaviour

The indexer tracks the difference between the latest ledger it has fully ingested and the network's current latest ledger, exposed as a metric (following whatever metrics format epic E18's observability work standardizes on, or a simple health endpoint if that epic has not landed yet) and as a field in the REST API's health check.

## Acceptance criteria

- [ ] Lag is measured in ledgers and updated on every ingestion cycle.
- [ ] A health endpoint reports current lag and a boolean healthy/unhealthy verdict against a configurable threshold.
- [ ] A test simulates a stalled ingestion loop and confirms lag grows and the health check correctly flips to unhealthy past the threshold.

## Files

- indexer/src/health.rs
