---
title: "docs(security): add the verifier surface to the audit-readiness scope"
labels: [docs, security, good-first-issue]
epic: E04
wave: 2
depends_on: [0089]
---

## Summary

Epic E19 (Security & Audit Readiness) presumably maintains or will maintain a scope document listing what an external auditor needs to review. Epic E04 adds a meaningfully new trust boundary (arbitrary third-party contracts called from execute_task) that must be explicitly named in that scope rather than assumed to be covered by a general "review the contract" instruction.

## Expected behaviour

Whatever audit-scope document exists or is created under epic E19 gets an explicit line item for the verifier integration: the interface (issue 0071), the three reference implementations (issues 0077-0079), the failure-handling policy (issue 0075), and the security-considerations write-up (issue 0089) as the primary artifacts an auditor should review for this surface.

## Acceptance criteria

- [ ] Verifier surface is explicitly named as an audit scope item, not left implicit.
- [ ] Links to the specific artifacts (design doc, security considerations, reference implementations) an auditor would start from.
- [ ] If no audit-scope document exists yet in this repository, this issue creates a minimal one rather than waiting for epic E19 to formally start -- security scope for shipped code should not wait on an epic's scheduling.

## Files

- docs/AUDIT_SCOPE.md (or docs/VERIFIER_DESIGN.md's security section if a dedicated doc does not exist)
