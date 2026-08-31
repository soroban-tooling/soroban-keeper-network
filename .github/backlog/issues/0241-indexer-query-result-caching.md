---
title: "perf(indexer): cache expensive aggregate queries"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0227, 0228]
---

## Summary

The leaderboard (issue 0227) and protocol-stats (issue 0228) queries aggregate over potentially large event histories. Recomputing them from scratch on every request does not scale as the dashboard's traffic grows, even if each individual query is reasonably fast.

## Expected behaviour

A caching layer for these specific aggregate queries with a short, configurable time-to-live, so a burst of dashboard traffic does not translate into a burst of expensive database aggregation, while keeping the staleness window small enough that a viewer is not looking at meaningfully outdated numbers.

## Acceptance criteria

- [ ] Leaderboard and stats queries are served from cache within their time-to-live and recomputed after it expires.
- [ ] Cache invalidation (or short enough TTL as a substitute for explicit invalidation) is documented, including the tradeoff chosen and why.
- [ ] A load test demonstrates the caching layer measurably reduces database load under repeated identical queries.

## Files

- indexer/src/cache.rs
