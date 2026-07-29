---
title: "feat(sdk-ts): support fee-bump transactions for sponsored submission"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0170]
---

## Summary

A common pattern for improving UX (a dApp sponsoring its users' transaction fees so a new user doesn't need XLM before they can do anything) uses Stellar's fee-bump transaction wrapper. The SDK's transaction-building layer (issue 0170) should support this as an explicit option rather than assuming the account building a transaction always pays its own fee.

## Expected behaviour

An option on `buildTransaction` (or a wrapping helper) to produce a fee-bump-ready inner transaction, plus a separate helper for the sponsor to wrap and sign the fee-bump envelope, following Stellar's standard fee-bump transaction structure.

## Acceptance criteria

- [ ] A test constructs a fee-bumped `registerTask` call where the source account has zero XLM balance for fees, and confirms the sponsor's fee-bump makes it submittable.
- [ ] Documented as an option specifically for the onboarding-UX use case, with a worked example.

## Files

- packages/sdk-ts/src/transactionBuilder.ts
