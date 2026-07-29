---
title: "docs(contributing): update the 'where contributors come in' pointer now that epics E03-E05 have real issues"
labels: [docs, good-first-issue]
epic: E05
wave: 2
depends_on: []
---

## Summary

The contract's own top-of-file doc comment and CONTRIBUTING.md both describe, in prose, roughly what kind of work is next for contributors. That prose was written when epics E03-E05 were only scope estimates in the README's epic index. Now that 100 concrete issues exist across those epics, the pointer should say so specifically rather than speaking in generalities.

## Expected behaviour

Update the "Where contributors come in" doc comment in contracts/keeper-registry/src/lib.rs and the equivalent section of CONTRIBUTING.md to name the actual epics with published issues (fuzzing/invariant testing, execution verifiers, batch operations) and point at the backlog README's epic index for the full list, rather than the more vague "Phase 2" language that predates this wave.

## Acceptance criteria

- [ ] Both locations are updated consistently with each other.
- [ ] Points a new contributor at .github/backlog/README.md's epic index as the canonical, up-to-date list rather than re-describing it in two places that can drift.

## Files

- contracts/keeper-registry/src/lib.rs
- CONTRIBUTING.md
