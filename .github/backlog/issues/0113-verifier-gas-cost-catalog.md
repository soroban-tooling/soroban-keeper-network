---
title: "docs: catalog measured resource cost for each reference verifier from epic E04"
labels: [docs, testing, intermediate]
epic: E05
wave: 2
depends_on: [0077, 0078, 0079, 0100]
---

## Summary

Once the three reference verifiers from epic E04 (issues 0077-0079) exist and issue 0100's per-entry-point resource reporting exists, this issue produces the concrete numbers issue 0076 (verifier budget guard) needed but could only reason about in the abstract: how expensive is each reference verifier's verify call in practice.

## Expected behaviour

A table in docs/VERIFIERS.md (issue 0088) giving measured CPU/memory cost for execute_task with each of the three reference verifiers attached, compared against the no-verifier baseline, so a dApp author or keeper bot author has real numbers instead of "it depends."

## Acceptance criteria

- [ ] Each reference verifier's cost is measured against the same baseline methodology issue 0100 established.
- [ ] Numbers are presented as a delta over the no-verifier case, not just an absolute figure.
- [ ] Cross-referenced from issue 0091's bot-side profitability logic, since this is exactly the data that logic needs.

## Files

- docs/VERIFIERS.md
