---
title: "security(registry): full review of the staking surface before mainnet consideration"
labels: [contract, security, advanced]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291, 0293, 0295]
---

## Summary

Closes the implementation portion of this epic with a dedicated security pass, mirroring the discipline applied to the verifier epic (issue 0089) and the indexer (issue 0248), before any staking functionality is considered ready for a real deployment carrying real value.

## Expected behaviour

A review covering at minimum: whether the slash authorization model (issue 0291) has a single point of failure, whether the dispute window (issue 0293) can be gamed by timing a withdrawal attempt, whether unbonding (issue 0290) has any path to bypass the delay, and whether the appeal process (issue 0302) can be used to indefinitely stall a legitimate slash.

## Acceptance criteria

- [ ] Each concern above is explicitly addressed with a finding or a confirmation it does not apply.
- [ ] Any finding is fixed before this closes; this epic should not ship with a known, unaddressed finding.
- [ ] The review is documented for a future external audit to reference, per epic E19's audit-readiness goals.

## Files

- docs/STAKING_SECURITY_REVIEW.md
