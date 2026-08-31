---
title: "security(registry): review the reputation system for gaming vectors"
labels: [contract, security, advanced]
epic: E07
wave: 4
depends_on: [0319, 0321, 0323]
---

## Summary

A reputation system that influences claim eligibility (issue 0323) creates an incentive to game it. This issue is the dedicated review, mirroring the discipline applied to every other epic's closing security pass (issues 0089, 0248, 0311).

## Expected behaviour

A review covering: whether a keeper can artificially inflate its own reputation (self-dealing by registering and immediately executing trivial tasks it owns itself, if nothing prevents an address from being both a task's owner and its executing keeper), whether the decay function can be exploited by timing activity around decay boundaries, and whether the eligibility floor creates a perverse incentive to avoid ever attempting a risky-but-legitimate task for fear of a rare miss dropping a keeper below the floor.

## Acceptance criteria

- [ ] Each concern above is explicitly addressed with a finding or a confirmation it does not apply.
- [ ] If self-dealing is found to be a real gaming vector, a mitigation is proposed (at minimum, documented as a known limitation) before this closes.
- [ ] The review is documented for epic E19's audit-readiness work to reference.

## Files

- docs/REPUTATION_SECURITY_REVIEW.md
