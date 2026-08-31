---
title: "feat(indexer): outbound alert hooks for high-signal on-chain events"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0222]
---

## Summary

Some events matter enough that a maintainer wants to know immediately rather than by checking a dashboard: an admin transfer, a pause, a fee change, or a sweep above a configurable amount. This issue adds a way to push those to an external channel as they are ingested.

## Expected behaviour

A configurable set of rules (event type, and optionally a threshold for numeric fields like a sweep amount) that trigger an outbound webhook or notification when matched, evaluated at ingestion time rather than requiring a separate polling process.

## Suggested approach

Keep the notification transport itself pluggable (a generic webhook is the minimal viable version) rather than hardcoding a specific provider like Slack or PagerDuty into the indexer's core; epic E18's observability work may standardize a specific transport later.

## Acceptance criteria

- [ ] Rules are configurable without a code change.
- [ ] A matched event triggers exactly one notification, not zero and not a duplicate on retry (build on issue 0230's idempotency work).
- [ ] A test confirms a configured rule fires for a matching event and does not fire for a non-matching one.

## Files

- indexer/src/alerts.rs
