---
title: "refactor(keeper-bot): migrate the reference keeper bot onto the new TypeScript SDK"
labels: [keeper-bot, enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0154, 0156, 0157, 0160, 0166, 0167, 0188, 0189]
---

## Summary

The best proof that this SDK is actually good is using it to replace the hand-rolled plumbing in the very example (`examples/keeper-bot`) that motivated several of its design decisions (the retry utility in issue 0188, the network presets in issue 0189, and the event decoders in issue 0167 are all directly modeled on this bot's existing code). This issue does that migration.

## Expected behaviour

`examples/keeper-bot/index.js`'s `invokeContract`/`readContract`/manual event decoding/`withRetry`/`NETWORK_CONFIG` are replaced with calls into the new SDK, with the bot's own unique logic (profitability checks, off-chain execution, the outcome cache from wave-2 work) untouched -- this is a plumbing swap, not a rewrite of the bot's behavior.

## Acceptance criteria

- [ ] The bot's existing test suite (once issue 0128-style testing lands and is fixed) still passes after the migration, proving behavior is preserved.
- [ ] The bot's line count drops meaningfully (the whole point of the SDK existing), and the diff is reviewed specifically for "does this still do exactly what it did before" rather than sneaking in behavior changes alongside the plumbing swap.
- [ ] This migration itself becomes the primary content of issue 0184's before/after migration guide -- coordinate rather than writing two independent examples.

## Files

- examples/keeper-bot/index.js
- examples/keeper-bot/package.json
