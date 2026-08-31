---
title: "feat(governance): events for the full proposal lifecycle"
labels: [contract, enhancement, good-first-issue]
epic: E09
wave: 4
depends_on: [0363, 0364, 0366, 0367]
---

## Summary

Adds event coverage for proposal creation, each vote cast, a proposal passing or failing, entering the timelock queue, and execution, following the project's established emit-everything convention.

## Acceptance criteria

- [ ] Each lifecycle transition has its own event with sufficient payload to reconstruct the full proposal history from events alone.
- [ ] A vote-cast event does not leak more than the design intends — decide and document whether individual votes are public (likely, for a transparent governance system) versus only aggregate tallies.
- [ ] README or a governance-specific document lists the event topic pairs.

## Files

- contracts/governance/src/lib.rs
