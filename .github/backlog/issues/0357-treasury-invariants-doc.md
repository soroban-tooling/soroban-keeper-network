---
title: "docs(architecture): document the treasury's money invariants"
labels: [docs, security, contract, intermediate]
epic: E08
wave: 4
depends_on: [0345, 0050]
---

## Summary

Following issue 0050's precise, numbered invariant format, this issue states the treasury's own conservation and access-control invariants (distribution never creates or destroys value, per issue 0345's property test; only configured recipients ever receive a distribution; only the admin or automated sweep path can trigger a distribution, per issue 0338's design).

## Acceptance criteria

- [ ] Each invariant is stated precisely enough to be testable and cross-referenced to its verifying test.
- [ ] The document is added to or clearly linked from docs/ARCHITECTURE.md's existing invariant section rather than existing in isolation.

## Files

- docs/ARCHITECTURE.md
