---
title: "test(registry): confirm fee accrual only ever happens on a successful, verified execution"
labels: [testing, contract, good-first-issue]
epic: E04
wave: 2
depends_on: [0074]
---

## Summary

execute_task calls accrue_fee only after crediting the keeper, which per issue 0074's implementation only happens if the attached verifier approves. This issue is a small, focused test confirming that ordering holds -- a rejected verification must not accrue any protocol fee, since no reward was actually paid out for the protocol to have taken a cut of.

## Expected behaviour

A test: register a task with an always-reject verifier, attempt execute_task, confirm it fails, and confirm fees_accrued() is completely unchanged by the attempt -- not partially incremented, not incremented and then not rolled back, simply untouched because the fee-accrual line of code was never reached.

## Acceptance criteria

- [ ] fees_accrued() before and after a rejected verification attempt are asserted equal.
- [ ] Test also confirms the keeper's balance is equally untouched, tying back to issue 0084's existing assertions but stated here as its own explicit fee-focused check for discoverability.

## Files

- contracts/keeper-registry/src/test.rs
