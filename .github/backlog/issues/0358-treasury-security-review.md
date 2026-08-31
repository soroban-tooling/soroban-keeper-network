---
title: "security(treasury): full review before mainnet consideration"
labels: [contract, security, advanced]
epic: E08
wave: 4
depends_on: [0340, 0342, 0344, 0350]
---

## Summary

Closes the implementation portion of this epic with a dedicated security pass, mirroring every other epic's closing review (issues 0089, 0248, 0311, 0336).

## Expected behaviour

A review covering: whether recipient reconfiguration (issue 0342) can be used to redirect funds already in flight, whether the upgrade path (issue 0350) could be used to alter distribution logic in a way that bypasses the property test's conservation guarantee, and whether the treasury's relationship to the registry (issue 0341's integration) creates any new way to affect the registry's own solvency invariant.

## Acceptance criteria

- [ ] Each concern above is explicitly addressed with a finding or a confirmation it does not apply.
- [ ] Any finding is fixed before this closes.
- [ ] The review is documented for epic E19's audit-readiness work.

## Files

- docs/TREASURY_SECURITY_REVIEW.md
