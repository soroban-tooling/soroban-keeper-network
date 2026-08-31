---
title: "docs(security): scope note for a future governance and token audit"
labels: [contract, security, docs, good-first-issue]
epic: E09
wave: 4
depends_on: [0360]
---

## Summary

Following the pattern issue 0139 established for the verifier epic (a scope note clarifying exactly what a future external audit needs to cover), this issue writes the equivalent for governance and the KPRS token before an audit is commissioned, since this epic's scope (a token, proposal logic, and the registry's own admin migration) is large enough that an auditor needs a precise boundary, not just "review the governance code."

## Acceptance criteria

- [ ] States plainly which contracts are in scope (token, governance) and which existing contracts are affected but out of primary scope (the registry, beyond the specific admin-migration change).
- [ ] Names the highest-risk components specifically: proposal execution's cross-contract call into the registry, the timelock's boundary correctness, and voting-power snapshotting.
- [ ] Cross-references the security reviews already completed for this epic (issue 0371) rather than duplicating their findings.

## Files

- docs/GOVERNANCE_AUDIT_SCOPE.md
