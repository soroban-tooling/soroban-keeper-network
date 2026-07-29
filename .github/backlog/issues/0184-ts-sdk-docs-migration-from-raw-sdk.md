---
title: "docs(sdk-ts): migration guide from raw @stellar/stellar-sdk usage"
labels: [docs, good-first-issue]
epic: E12
wave: 3
depends_on: [0154, 0166]
---

## Summary

The existing `examples/keeper-bot` is written entirely against raw `@stellar/stellar-sdk`, hand-rolling exactly the plumbing this SDK now provides. Once this SDK exists, that example is the single best illustration of "before and after" for a migration guide, since it is real, working code already in this repository.

## Expected behaviour

A side-by-side comparison (in the SDK's docs) showing a few representative snippets from `examples/keeper-bot/index.js` — `invokeContract`'s manual transaction building, the hand-decoded event topic filter, the raw error handling — next to the equivalent SDK call, demonstrating concretely what adopting the SDK removes from a consumer's own code.

## Acceptance criteria

- [ ] At least three real before/after snippets, sourced from the actual current `examples/keeper-bot/index.js`, not invented examples.
- [ ] Honest about what does *not* change (the bot still needs its own retry/backoff policy, profitability logic, and off-chain execution — the SDK does not replace the whole bot, just the contract-interaction plumbing).

## Files

- packages/sdk-ts/docs/MIGRATION.md
