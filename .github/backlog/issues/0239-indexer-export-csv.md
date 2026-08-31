---
title: "feat(indexer): bulk CSV export for offline analysis"
labels: [indexer, enhancement, good-first-issue]
epic: E14
wave: 3
depends_on: [0225]
---

## Summary

Not every consumer wants a live API; a researcher or an integrator doing offline analysis may want a full or filtered dump of the event history to load into their own tooling.

## Expected behaviour

An export endpoint or CLI command producing a CSV (or newline-delimited JSON, whichever is more natural given the schema) of events, filterable by event type, address, and time range, matching the same query capability the REST API already exposes.

## Acceptance criteria

- [ ] Export supports the same filters as the REST API's event feed.
- [ ] Large exports stream rather than buffering the entire result set in memory.
- [ ] A sample export is documented with its exact column layout so a consumer can write a parser against it confidently.

## Files

- indexer/src/export.rs
