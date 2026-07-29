---
title: "docs: epic E03 retrospective -- coverage achieved and known gaps"
labels: [docs, good-first-issue]
epic: E03
wave: 2
depends_on: [0070, 0135]
---

## Summary

Closes out epic E03 the same way issue 0118 and 0141 do for E05 and E04: a summary of what fuzzing and property-test coverage exists by the end of this epic, and what was explicitly investigated but not adopted (mutation testing per issue 0135, if it concluded "not practical").

## Expected behaviour

A closing section (in the fuzzing guide from issue 0070, or docs/ARCHITECTURE.md near the invariants section) listing every invariant from I-1 through I-8 (once issue 0132 adds I-8) alongside which property test or fuzz target actually covers it, so a future contributor can see the coverage map at a glance rather than cross-referencing 20 separate issues.

## Acceptance criteria

- [ ] Every numbered invariant has at least one linked test or fuzz target, or is explicitly flagged as not yet covered.
- [ ] Mutation testing's conclusion (issue 0135) is summarized.
- [ ] This document is the one a new contributor is pointed to (from CONTRIBUTING.md) when asked "how do I know if my change broke an invariant."

## Files

- docs/ARCHITECTURE.md
- CONTRIBUTING.md
