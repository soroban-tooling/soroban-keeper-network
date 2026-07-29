---
title: "docs: define the event schema a future indexer (epic E14) needs for verifier-gated tasks"
labels: [docs, intermediate]
epic: E04
wave: 2
depends_on: [0080, 0093]
---

## Summary

Epic E14 (Event Indexer, wave 3) will eventually need to consume every event this contract emits, including the verifier-related ones added in this epic (VerificationFailed from issue 0080, the verifier-attached event from issue 0093). Rather than let the indexer epic rediscover this contract's event shapes from scratch when it starts, this issue writes down the exact schema now, while the reasoning for each field is still fresh.

## Expected behaviour

A section in README's existing event table (already maintained per wave-1 issue 0017's fix for table/code drift) or a dedicated docs/EVENTS.md, listing every verifier-related event's exact topic tuple and data payload shape, with a one-line note on what an indexer would use each field for (for example, "verifier address, so a dashboard can show which tasks require which verification method").

## Acceptance criteria

- [ ] Every verifier-related event from this epic is documented with its exact topics and data shape.
- [ ] Each field has a stated indexer-relevant purpose, not just a type.
- [ ] Referenced (added as a dependency) from whatever issue eventually kicks off epic E14, once wave 3 is drafted.

## Files

- README.md
- docs/EVENTS.md
