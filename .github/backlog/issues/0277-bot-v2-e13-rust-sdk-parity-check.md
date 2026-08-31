---
title: "chore: confirm keeper-bot-v2 and the Rust SDK example agree on core logic"
labels: [keeper-bot, rust-sdk, docs, good-first-issue]
epic: E15
wave: 3
depends_on: [0214, 0254]
---

## Summary

Epic E13's Rust SDK example (issue 0214) and this epic's v2 JavaScript bot both implement the same fundamental keeper loop against the same contract. Divergence between the two on something like profitability calculation or lock-window handling would mean one of them is wrong, or that a real difference in behavior is undocumented.

## Expected behaviour

A short review comparing the two implementations' handling of profitability, retry classification, and lock-window awareness, confirming they agree or documenting exactly why they intentionally differ.

## Acceptance criteria

- [ ] Profitability, retry, and lock-window logic are compared side by side.
- [ ] Any intentional difference is documented with its reasoning.
- [ ] Any unintentional divergence found is filed as a fix in whichever of the two is actually wrong, not silently left unreconciled.

## Files

- docs/KEEPER_BOT_V2_DESIGN.md
