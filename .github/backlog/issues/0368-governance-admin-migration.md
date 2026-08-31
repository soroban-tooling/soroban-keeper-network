---
title: "feat(registry): the one-time admin migration to the governance contract"
labels: [contract, security, advanced]
epic: E09
wave: 4
depends_on: [0367]
---

## Summary

Implements the actual, one-time transfer_admin call handing the registry's admin role to the governance contract's own address, the migration step issue 0360 and issue 0367 both depend on. This is treated as its own issue rather than folded into issue 0367 because it is irreversible in practice (transferring admin away from a human-controlled key to a contract address) and deserves its own explicit review and sign-off.

## Expected behaviour

A documented, tested procedure — not necessarily new contract code, since transfer_admin already exists — for the current admin to hand control to the governance contract, requiring both the current admin's and the governance contract's auth per transfer_admin's existing dual-auth design. Confirm a contract address can actually satisfy the require_auth the incoming-admin side of transfer_admin demands, since that differs from a human signing with a keypair.

## Acceptance criteria

- [ ] The exact procedure is documented step by step.
- [ ] A test on a local network performs the actual migration and confirms every previously admin-gated function on the registry now requires the governance contract's own authorization, not the original admin's.
- [ ] The irreversibility is stated plainly: after this migration, there is no path back to single-admin control except through governance itself passing a proposal to transfer admin elsewhere, if issue 0360's enumerated proposal types even allow that.

## Files

- docs/GOVERNANCE_DESIGN.md
- contracts/governance/src/test.rs
