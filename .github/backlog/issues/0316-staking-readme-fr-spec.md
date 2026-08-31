---
title: "docs(readme): add the staking functional requirements"
labels: [docs, good-first-issue]
epic: E06
wave: 4
depends_on: [0288, 0289, 0290, 0291]
---

## Summary

Following the precise, testable FR-N style README.md already uses for the rest of the contract's behavior (see FR-7's admin controls table as the reference), this issue adds the equivalent for staking once its core entry points are implemented.

## Acceptance criteria

- [ ] New FR entries state, precisely enough to map to a test, the deposit, unbonding delay, minimum-stake requirement (if any), and slash authorization rules.
- [ ] The storage model table is extended with the new staking-related keys.
- [ ] Numbered consistently with the existing FR-1 through FR-7 sequence.

## Files

- README.md
