---
title: "feat(keeper-bot-v2): expose operational metrics"
labels: [keeper-bot, observability, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1's header comment lists a Prometheus metrics endpoint under production additions a real keeper should add. This issue implements it for v2.

## Expected behaviour

A metrics endpoint (or export format matching whatever epic E18's observability work standardizes on) exposing at minimum: tasks evaluated, claimed, executed, and skipped per round with skip reason, current keeper balance, round duration, and RPC error counts by type.

## Acceptance criteria

- [ ] All stated metrics are exposed and update correctly across rounds.
- [ ] Skip reasons (not claimable, unprofitable, no executor, other) are distinguishable, not collapsed into one counter.
- [ ] A metrics scrape does not itself interfere with or slow down the keeper loop it is measuring.

## Files

- (v2 package)/src/metrics.*
