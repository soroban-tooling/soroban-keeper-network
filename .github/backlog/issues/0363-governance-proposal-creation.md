---
title: "feat(governance): proposal creation restricted to the governable parameter list"
labels: [contract, enhancement, advanced]
epic: E09
wave: 4
depends_on: [0360, 0362]
---

## Summary

Implements proposal creation against the closed list of governable parameters issue 0360 enumerated, deliberately not an arbitrary-call design — an open-ended "execute any contract call" proposal type is a materially larger and harder-to-review attack surface than a fixed menu of known-safe parameter changes, and issue 0360 should have already decided against it for a first version.

## Expected behaviour

A create_proposal entry point taking one of the enumerated parameter-change types and its new value, requiring the creator to hold at least the minimum proposal threshold issue 0360 specified, rejecting anything not on the enumerated list.

## Acceptance criteria

- [ ] Only the exact parameter types issue 0360 enumerated can be proposed; an attempt to encode an arbitrary call is rejected, not merely discouraged by convention.
- [ ] The minimum-holding threshold is enforced, with a specific typed error for a caller below it.
- [ ] A test attempts every enumerated proposal type successfully and confirms a non-enumerated type is rejected.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
