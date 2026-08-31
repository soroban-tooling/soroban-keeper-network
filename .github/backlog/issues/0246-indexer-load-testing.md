---
title: "test(indexer): establish a load-testing baseline before launch"
labels: [indexer, testing, intermediate]
epic: E14
wave: 3
depends_on: [0225, 0226, 0241]
---

## Summary

Before the indexer's API is relied upon by the dashboard and third parties, its actual capacity under realistic query load should be measured rather than assumed. This produces the first baseline and the tooling to repeat the measurement after future changes.

## Expected behaviour

A repeatable load-testing script exercising the REST API's heaviest endpoints (the aggregate queries from issues 0227 and 0228 in particular) and the WebSocket feed under a realistic number of concurrent subscribers, producing a baseline report of latency and throughput.

## Acceptance criteria

- [ ] The load test is scripted and repeatable, not a one-off manual exercise.
- [ ] A baseline report is committed, including the hardware/environment it was measured against.
- [ ] The caching layer from issue 0241 is confirmed to measurably help under this specific load test, not just in isolation.

## Files

- indexer/loadtest/
