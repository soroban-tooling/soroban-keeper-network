---
title: "docs(demo): add a staking walkthrough"
labels: [docs, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

docs/DEMO.md walks a reader through the core task lifecycle. Once staking exists, it needs its own section: depositing stake, seeing it reflected in keeper_stake, and what happens on a slash, so a reader exploring the contract's capabilities is not left to reconstruct the flow from the design document alone.

## Acceptance criteria

- [ ] The walkthrough covers deposit, unbonding, withdrawal, and a slash, using the CLI or SDK examples already established elsewhere in the demo document's style.
- [ ] Cross-references docs/STAKING_DESIGN.md rather than restating its reasoning.

## Files

- docs/DEMO.md
