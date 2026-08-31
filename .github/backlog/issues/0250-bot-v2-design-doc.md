---
title: "design(keeper-bot): scope and architecture for keeper bot v2"
labels: [keeper-bot, docs, advanced]
epic: E15
wave: 3
depends_on: []
---

## Summary

Opens epic E15. examples/keeper-bot/index.js is a single file, deliberately kept beginner-friendly (CONTRIBUTING.md states this explicitly: no TypeScript, CommonJS, one file). It has no persistent state across restarts, processes one round at a time with no concurrency, and every profitability or executor decision lives inline in keeperLoop. This epic is a v2 aimed at operators running a keeper competitively, not at the newcomer audience the current example serves.

## Questions this document must answer

- Relationship to the existing example: is v2 a separate package (examples/keeper-bot-v2 or a standalone repository) or a v2 mode within the same package? State the reasoning; the existing bot's simplicity is a stated goal (CONTRIBUTING.md), and v2's added complexity (a database, concurrency, possibly TypeScript) may be in tension with keeping the original approachable for newcomers.
- Persistence: what state actually needs to survive a restart (in-flight claims, the outcome cache issue 0135's cursor-tracking work already introduced in v1) and what storage fits that (the v1 header comment already names SQLite or Redis as the intended drop-in).
- Concurrency model: can one keeper process handle multiple tasks in flight at once, and if so, how does it avoid double-submitting or exceeding its own resource budget.
- Executor interface: v1 already has a minimal pluggable executor (ttlExtensionExecutor, simulatedExecutor). Does v2 keep this shape or redesign it for a richer set of task types.
- Profitability: v1 has no profitability check at all (wave 1 issue 0041 targeted this for v1 but the gap may still be open in v2's intended scope) — decide where that logic lives and what data it needs (gas cost estimates, current fee_bps, reward).

## Acceptance criteria

- [ ] Every question above has an explicit decision, with rationale.
- [ ] The exact package location and language/runtime are pinned.
- [ ] The persistence schema (or a pointer to a follow-up design issue for it) is specified enough for issue 0251 to implement against.

## Files

- docs/KEEPER_BOT_V2_DESIGN.md
