---
title: "feat(treasury): an upgrade entry point matching the registry's own pattern"
labels: [contract, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0339]
---

## Summary

If the treasury is a separate deployed contract, it needs the same upgrade capability the registry has (upgrade in admin.rs, using deployer().update_current_contract_wasm), so a bug found after deployment does not require abandoning the contract and migrating every recipient configuration to a new address.

## Acceptance criteria

- [ ] An admin-gated upgrade entry point matching the registry's own signature and semantics.
- [ ] Storage layout is preserved across an upgrade, verified by a test that upgrades and confirms existing recipient configuration and totals survive intact.
- [ ] A test confirms a non-admin cannot upgrade, mirroring the registry's own test_upgrade_by_non_admin_fails coverage.

## Files

- contracts/treasury/src/lib.rs
- contracts/treasury/src/test.rs
