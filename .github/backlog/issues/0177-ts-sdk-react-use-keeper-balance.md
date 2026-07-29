---
title: "feat(sdk-ts-react): useKeeperBalance and useWithdrawRewards hooks"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0173, 0163, 0160]
---

## Summary

A keeper-facing dashboard component showing accrued balance and a withdraw button needs both a polling read hook and a mutation hook, and the two should compose so a successful withdrawal automatically refreshes the displayed balance without the consumer wiring that up manually.

## Expected behaviour

`useKeeperBalance(address, { pollIntervalMs? })` following the `useTask` polling pattern, and `useWithdrawRewards()` following the mutation-hook pattern, with the withdrawal hook accepting an optional callback or exposing an event the balance hook can react to (or, more simply, the pattern is documented: call `balanceHook.refetch()` after a successful withdrawal — pick whichever composition approach is simpler and document it clearly either way).

## Acceptance criteria

- [ ] Both hooks individually tested per the patterns from issues 0174 and 0175.
- [ ] The composition pattern (how a consumer refreshes balance after withdrawal) is demonstrated in a test or example, not left for the consumer to figure out.

## Files

- packages/sdk-ts/src/react/useKeeperBalance.ts
- packages/sdk-ts/src/react/useWithdrawRewards.ts
