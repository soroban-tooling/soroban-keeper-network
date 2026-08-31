---
title: "design(governance): decide whether keeper activity earns KPRS retroactively"
labels: [contract, docs, intermediate]
epic: E09
wave: 4
depends_on: [0360, 0361]
---

## Summary

If issue 0360's distribution design allocated some KPRS supply to early keepers based on execution history, this issue specifies the exact snapshot mechanism: which historical events count (successful executions, since the registry's genesis, per epic E14's indexer if it has already backfilled that history), how activity converts to a token amount, and how a keeper claims their allocation.

## Acceptance criteria

- [ ] The exact eligibility snapshot (source of truth, cutoff point) is specified precisely enough to compute deterministically from indexed history.
- [ ] The claim mechanism (a Merkle-proof claim against a published snapshot is a common, gas-efficient pattern for this kind of one-time distribution; confirm this or whatever mechanism is chosen) is specified.
- [ ] If issue 0360 did not allocate any supply to historical keeper activity, this issue is closed as not applicable, stating that explicitly.

## Files

- docs/GOVERNANCE_DESIGN.md
