---
title: "design(indexer): architecture and scope for the event indexer"
labels: [indexer, docs, advanced]
epic: E14
wave: 3
depends_on: []
---

## Summary

Opens epic E14. Nothing in this project currently persists the registry's event history anywhere durable; a keeper bot's own event scan (examples/keeper-bot) only looks back a bounded window and discards what it reads. A real indexer needs a design decided before any code, the same way epic E04's verifier work started with issue 0071 rather than jumping to implementation.

## Questions this document must answer

- Ingest mechanism: polling getEvents on an interval (the pattern the keeper-bot already uses) versus subscribing to a streaming source if the target RPC provider offers one. State which, and why.
- Storage: what database, and why it fits an append-mostly, query-heavy workload of fifteen event types against one contract.
- Reorg handling: Stellar's finality model and what the indexer does if a ledger it already ingested is later invalidated. State plainly whether this is a real risk on Stellar's consensus model or a defensive measure against RPC-node bugs, since the two motivate different handling.
- Backfill: how the indexer catches up from contract genesis on first run without re-implementing a slow path distinct from steady-state ingestion.
- API shape: what a consumer (the web dashboard in epic E17, a keeper bot, a third-party integrator) actually queries for — by task id, by owner address, by keeper address, by time range, or some combination — decided from real consumer needs, not speculatively.

## Expected output

docs/INDEXER_DESIGN.md answering each question with a decision and rationale, plus the exact schema (table names and columns, or the ingest queue shape if event-sourced) the rest of the epic implements against.

## Acceptance criteria

- [ ] Every question above has an explicit decision.
- [ ] The schema covers all fifteen events from events.rs by name, with their exact payload fields as defined there today, not as any older design document may have assumed.
- [ ] Reviewed and the schema locked before issues 0219 onward begin implementation.

## Files

- docs/INDEXER_DESIGN.md
