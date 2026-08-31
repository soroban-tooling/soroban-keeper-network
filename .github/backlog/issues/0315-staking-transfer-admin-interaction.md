---
title: "test(registry): confirm slash authorization correctly follows admin transfer"
labels: [testing, contract, good-first-issue]
epic: E06
wave: 4
depends_on: [0291]
---

## Summary

If slash's authorization (per issue 0288's design) is admin-gated, it must correctly recognize a new admin immediately after transfer_admin, with no stale reference to the previous admin, the same guarantee every other admin-gated function already provides via require_admin.

## Acceptance criteria

- [ ] A test transfers admin, then confirms the old admin can no longer call slash and the new admin can.
- [ ] If slash uses a different authorization path than require_admin (e.g., a dispute-resolution role distinct from the protocol admin), this issue instead confirms that separate role transfers correctly through whatever mechanism issue 0288 specifies for it.

## Files

- contracts/keeper-registry/src/test/staking.rs
