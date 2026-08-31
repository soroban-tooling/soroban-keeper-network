---
title: "feat(conditions): a reference price-threshold condition contract"
labels: [contract, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0390, 0393]
---

## Summary

A working reference implementation of the condition interface issue 0390 specified: a contract that returns true once a configured oracle-reported price crosses a configured threshold, the most directly useful condition type for the OraclePricePush and Liquidation task types the contract already defines.

## Acceptance criteria

- [ ] Implements the condition interface exactly as issue 0390 specified.
- [ ] Reads price from a configured oracle contract at call time rather than trusting any cached or caller-supplied value, the same pattern epic E04's never-implemented oracle-verifier design (issue 0078) intended.
- [ ] An end-to-end test registers a task with this condition attached, confirms is_claimable is false below the threshold and true once a mock oracle reports a price crossing it.

## Files

- contracts/conditions/price-threshold/src/lib.rs
- contracts/conditions/price-threshold/src/test.rs
