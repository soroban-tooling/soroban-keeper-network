---
title: "feat(keeper-bot-v2): surface open proposals and voting status"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E09
wave: 4
depends_on: [0370, 0257]
---

## Summary

An operator running keeper-bot-v2 who also holds KPRS may want visibility into open governance proposals without a separate tool, similar to how issue 0330 surfaced reputation directly in the bot's own metrics and CLI.

## Acceptance criteria

- [ ] The CLI inspection commands (issue 0265) can list open proposals and whether the operator's configured address has voted.
- [ ] This is read-only visibility; the bot does not vote automatically on the operator's behalf, since a voting decision should not be delegated to an automated keeper process without the operator's explicit, per-proposal action.

## Files

- examples/keeper-bot-v2/src/cli.*
