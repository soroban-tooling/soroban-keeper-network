---
title: "test(keeper-bot-v2): benchmark round latency against v1 under identical load"
labels: [keeper-bot, testing, intermediate]
epic: E15
wave: 3
depends_on: [0253, 0261, 0262]
---

## Summary

The concurrency, prioritization, and indexer-integration work in this epic (issues 0253, 0261, 0262) all exist to make v2 faster or smarter than v1 under real competition. Without a benchmark comparing the two under identical simulated load, there is no evidence any of it actually helped.

## Expected behaviour

A benchmark harness running v1 and v2 against the same simulated candidate-task load (same reward distribution, same claim contention) and reporting round latency, tasks won, and net profit for each, so the epic's value is demonstrated rather than assumed.

## Acceptance criteria

- [ ] The benchmark runs both versions against genuinely identical simulated conditions.
- [ ] Results are committed as a report, not just observed once and discarded.
- [ ] If v2 does not measurably outperform v1 on at least one of the measured dimensions, that is reported honestly rather than the benchmark being adjusted until it shows an improvement.

## Files

- (v2 package)/benchmark/
