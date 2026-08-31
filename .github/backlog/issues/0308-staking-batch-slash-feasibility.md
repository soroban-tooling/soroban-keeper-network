---
title: "design(registry): feasibility study — batch slashing for a systemic incident"
labels: [contract, docs, intermediate]
epic: E06
wave: 4
depends_on: [0291]
---

## Summary

A single admin call slashing one keeper (issue 0291) does not scale if a systemic incident implicates many keepers at once (a coordinated exploit attempt, for instance). This is a feasibility study, following the same honest-about-uncertainty framing epic E05's batch-claim feasibility study (issue 0099) used: the answer may reasonably be that batch slashing is not worth building.

## Expected output

A recommendation on whether a batch_slash entry point is worth the added complexity and attack surface (an admin capable of slashing many keepers in one call is a more attractive target and a more dangerous bug surface than one that can only slash one at a time), or whether repeated single slash calls are an acceptable operational cost for the rare case this would matter.

## Acceptance criteria

- [ ] The tradeoff is explicitly weighed, not skipped.
- [ ] A clear recommendation is made.
- [ ] If batch slashing is recommended, it is scoped as a new, separate issue rather than implemented as part of this study.

## Files

- docs/STAKING_DESIGN.md
