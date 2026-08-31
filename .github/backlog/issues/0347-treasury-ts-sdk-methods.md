---
title: "feat(ts-sdk): typed client for the treasury contract"
labels: [ts-sdk, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0340, 0342, 0346]
---

## Summary

Adds a TypeScript client for the treasury contract, following the same conventions the registry's own SDK client established, as a separate client type since the treasury is a distinct deployed contract per issue 0338's design.

## Acceptance criteria

- [ ] All treasury entry points and views are wrapped.
- [ ] Typed error decoding covers the treasury's own error enum.
- [ ] A test against a local network configures recipients, triggers a distribution, and confirms the SDK's views agree with on-chain state.

## Files

- ts-sdk/src/treasury-client.ts
- ts-sdk/test/treasury.test.ts
