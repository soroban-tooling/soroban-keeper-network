---
title: "security(governance): checks-effects-interactions review of execution"
labels: [contract, security, advanced]
epic: E09
wave: 4
depends_on: [0367]
---

## Summary

execute_proposal (issue 0367) makes a cross-contract call into the registry, the same category of external interaction that required careful CEI ordering in the registry's own cancel_task and expire_task fixes. This issue is the dedicated review for governance's own execution path.

## Expected behaviour

Proposal state (marked executed) is written before the cross-contract call into the registry, so a reentrant or failed call cannot result in a proposal being executed twice or left in an inconsistent state.

## Acceptance criteria

- [ ] The ordering is verified by reading the actual code.
- [ ] A test confirms execute_proposal cannot be called twice for the same already-executed proposal.
- [ ] A test confirms a failure in the underlying registry call (e.g., a proposed fee_bps value that somehow fails registry-side validation) leaves the proposal in a recoverable state, not silently marked executed despite the change not actually landing.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
