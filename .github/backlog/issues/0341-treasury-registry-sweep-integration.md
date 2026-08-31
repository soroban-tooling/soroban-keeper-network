---
title: "feat(registry): wire sweep_fees to the treasury's distribution"
labels: [contract, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0338, 0340]
---

## Summary

Connects the registry's existing sweep_fees to the treasury contract from issue 0339, per whichever automation model issue 0338 chose.

## Expected behaviour

If sweep_fees now sends to the treasury contract rather than an arbitrary admin-supplied address, its signature or behavior may need to change; if it remains a plain transfer to a configured treasury address and distribution happens as a separate step, no change to sweep_fees itself is needed and this issue is limited to confirming that boundary is correct and documented.

## Acceptance criteria

- [ ] sweep_fees's actual behavior after this change matches issue 0338's design exactly.
- [ ] The registry's own solvency invariant (I-1 from docs/ARCHITECTURE.md) is unaffected by this change — sweep_fees still only ever moves the FeesAccrued amount, never task escrow or keeper balances.
- [ ] A test confirms a full round trip: fees accrue from an execution, sweep_fees moves them, and the treasury's distribution splits correctly reach each recipient.

## Files

- contracts/keeper-registry/src/admin.rs
- contracts/keeper-registry/src/test/withdraw.rs
