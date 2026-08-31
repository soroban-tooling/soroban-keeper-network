---
title: "feat(governance): quorum and passing-threshold evaluation"
labels: [contract, enhancement, intermediate]
epic: E09
wave: 4
depends_on: [0364]
---

## Summary

Implements the quorum and passing-threshold rules issue 0360 specified, determining whether a closed proposal actually passed.

## Acceptance criteria

- [ ] A proposal below the configured quorum fails regardless of how lopsided the votes that were cast are, verified by a test.
- [ ] A proposal meeting quorum but below the passing threshold fails; one meeting both passes.
- [ ] The evaluation is deterministic and can be computed by any observer from public on-chain state, not dependent on off-chain computation.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
