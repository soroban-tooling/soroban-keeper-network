---
title: "feat(governance): execute a passed, timelock-expired proposal against the registry"
labels: [contract, enhancement, advanced]
epic: E09
wave: 4
depends_on: [0366, 0360]
---

## Summary

Implements the actual cross-contract call that applies a passed proposal's effect to the registry (calling set_fee_bps, set_min_reward, or transfer_admin, depending on the proposal's enumerated type from issue 0363), completing the loop issue 0360's migration-path decision described.

## Expected behaviour

An execute_proposal(proposal_id) entry point, callable by whoever issue 0360 specified (anyone, once the timelock has elapsed, is the simplest and most permissionless option, consistent with expire_task's own permissionless design philosophy), that makes the actual call into the registry using whatever authorization the registry's admin-gated functions require — this almost certainly means the governance contract itself must become the registry's admin via transfer_admin as a one-time migration step, not that it needs the original admin's signature for every subsequent execution.

## Acceptance criteria

- [ ] Each enumerated proposal type correctly calls the corresponding registry function with the proposal's voted-on value.
- [ ] Execution is rejected before the timelock elapses and for a proposal that did not pass, with distinct typed errors for each.
- [ ] An end-to-end test creates a proposal, votes it to passing, waits out the timelock, executes it, and confirms the registry's actual state (fee_bps, min_reward, or admin) changed to the proposed value.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
