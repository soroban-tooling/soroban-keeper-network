---
title: "docs(architecture): document the governance invariants"
labels: [docs, security, contract, intermediate]
epic: E09
wave: 4
depends_on: [0373, 0050]
---

## Summary

Following issue 0050's precise, numbered invariant format, this states governance's own invariants: a proposal cannot execute before its timelock elapses, voting power is fixed at proposal creation and cannot be manipulated after the fact, and only the enumerated proposal types (issue 0363) can ever be created — no arbitrary-call escape hatch exists.

## Acceptance criteria

- [ ] Each invariant is stated precisely enough to be testable and cross-referenced to its verifying test (issue 0373's property test and issue 0366's timelock boundary tests in particular).
- [ ] Added to or clearly linked from docs/ARCHITECTURE.md's existing invariant section.

## Files

- docs/ARCHITECTURE.md
