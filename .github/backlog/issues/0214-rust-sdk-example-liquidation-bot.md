---
title: "docs(rust-sdk): a worked example — a minimal liquidation keeper in Rust"
labels: [rust-sdk, docs, intermediate]
epic: E13
wave: 3
depends_on: [0199, 0207, 0210]
---

## Summary

The keeper-bot example (JavaScript, examples/keeper-bot) is the reference implementation for the off-chain keeper role, but nothing demonstrates the Rust SDK filling the same role end to end. A native Rust example is the SDK's own dogfooding, the same reasoning issue 0194 applied to the TypeScript SDK.

## Expected behaviour

A minimal binary that polls for TaskRegistered events, checks is_claimable before attempting a claim, claims, performs a placeholder off-chain action, executes with a proof, and periodically withdraws. It should be a smaller, more direct translation of the JavaScript bot's logic, not a from-scratch redesign, so the two examples stay comparable.

## Suggested approach

Match the JavaScript bot's structure section by section (config validation, event fetching, the claim/execute loop, the withdrawal check) so a reader already familiar with examples/keeper-bot/index.js can follow the Rust version without relearning the whole design.

## Acceptance criteria

- [ ] Runs against a local or testnet deployment and successfully claims and executes at least one task in a manual test.
- [ ] Uses the client methods from issues 0199, 0207, and the retry policy from issue 0210, rather than reimplementing any of them inline.
- [ ] A README in the example's own directory explains what it does and how it differs in scope from the full JavaScript keeper-bot (no persistent state, no pluggable executors).

## Files

- rust-sdk/examples/liquidation-keeper/
