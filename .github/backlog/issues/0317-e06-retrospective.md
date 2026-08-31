---
title: "docs(registry): epic retrospective for staking and slashing"
labels: [contract, docs, good-first-issue]
epic: E06
wave: 4
depends_on: [0288, 0311]
---

## Summary

Closes epic E06. Records what was actually built against issue 0288's original design, any question deferred (the batch-slash feasibility study from issue 0308 in particular, if it recommended against building it), and the exact stable surface epic E07's reputation work and epic E09's governance work can build on, since both are natural future consumers of a keeper's staking history.

## Acceptance criteria

- [ ] Divergences from the original design in issue 0288 are named and justified.
- [ ] Deferred or explicitly-declined work (per issue 0308's recommendation, if declined) is named as such, not silently dropped.
- [ ] The stable surface for E07 and E09 to build against is stated plainly.

## Files

- docs/STAKING_DESIGN.md
