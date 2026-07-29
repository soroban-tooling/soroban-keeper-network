---
title: "docs: epic E04 retrospective -- what shipped, what was studied and deferred"
labels: [docs, good-first-issue]
epic: E04
wave: 2
depends_on: [0092, 0124, 0125, 0127, 0131]
---

## Summary

Like issue 0118 for epic E05, this closes out epic E04 with a summary of what actually shipped versus what was studied and explicitly deferred or declined -- the trust-model question (issue 0092), interface versioning (0124), composition (0125), the emergency-disable investigation (0127), and the prior-art research (0131) may each have concluded "not now" or "not needed," and those conclusions are easy to lose track of across 26 individual issues.

## Expected behaviour

A closing section in docs/VERIFIER_DESIGN.md summarizing, in one place: the shipped interface and its three reference implementations, the accepted trust-model decision, and a short list of "considered and deferred" items with one line each on why, linking to the full reasoning in each source issue.

## Acceptance criteria

- [ ] Every study-only issue's conclusion is represented, even briefly.
- [ ] A reader gets the full epic's shape without opening all 26 issues.

## Files

- docs/VERIFIER_DESIGN.md
