---
title: "feat(keeper-bot-v2): adapt submitted fees to current network conditions"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0254]
---

## Summary

v1 uses a fixed BASE_FEE for every submitted transaction. Under network congestion, a fixed low fee risks a transaction never being included, while an unnecessarily high fee on a quiet network wastes part of the keeper's margin the profitability check in issue 0254 is trying to protect.

## Expected behaviour

The bot queries current network fee conditions (via whatever the RPC surface exposes for this) and adjusts its submitted fee within a configurable ceiling, feeding the actual fee paid back into the profitability calculation from issue 0254 rather than assuming the fixed BASE_FEE.

## Acceptance criteria

- [ ] Submitted fee adapts to reported network conditions within a configurable ceiling.
- [ ] The profitability check uses the actual fee about to be paid, not a hardcoded assumption.
- [ ] A configurable ceiling prevents fee adaptation from ever exceeding what an operator has decided is acceptable, regardless of network conditions.

## Files

- (v2 package)/src/fees.*
