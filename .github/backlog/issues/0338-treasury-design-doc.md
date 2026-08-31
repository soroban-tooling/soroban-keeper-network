---
title: "design(treasury): architecture for automated fee routing and revenue accounting"
labels: [contract, docs, advanced]
epic: E08
wave: 4
depends_on: [0050]
---

## Summary

Opens epic E08. The registry today accrues protocol fees into a single FeesAccrued accumulator, swept manually by the admin to a single treasury address via sweep_fees. This is adequate for a simple single-recipient model but does not support splitting revenue across multiple stakeholders (a DAO treasury, a staking rewards pool once epic E06 lands, a public-goods fund) without a manual, trust-requiring admin step for every distribution.

## Questions this document must answer

- Single treasury contract versus routing rules in the registry itself: does this epic add a separate treasury contract the registry sweeps into, which then handles internal distribution, or does the registry gain multiple named recipients directly. State the tradeoff — a separate contract isolates distribution logic and bugs from the registry's core escrow safety, at the cost of an extra cross-contract call on every sweep.
- Distribution rules: fixed percentages to fixed addresses, configurable splits, or something more dynamic (weighted by stake, if epic E06 exists). Decide the actual mechanism, not just that one is needed.
- Automation: does sweep_fees remain a manual admin action that then triggers automatic downstream distribution, or does distribution happen automatically on some schedule or threshold without requiring sweep_fees to be called at all.
- Auditability: revenue accounting needs to be reconstructable after the fact (a treasury report). Decide whether this is purely event-driven (the indexer, epic E14, already ingests FeesSwept) or whether the treasury needs its own on-chain accounting distinct from just replaying sweep events.

## Acceptance criteria

- [ ] Every question above is answered with an explicit decision and rationale.
- [ ] The choice between a separate contract and in-registry routing is justified, not defaulted to without comparison.
- [ ] Exact storage keys and entry point signatures (for whichever contract ends up holding the logic) are pinned before implementation begins.

## Files

- docs/TREASURY_DESIGN.md
