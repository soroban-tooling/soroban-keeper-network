---
title: "feat(keeper-bot-v2): surface a keeper's own reputation in metrics and CLI"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E07
wave: 4
depends_on: [0320, 0257, 0265]
---

## Summary

An operator running keeper-bot-v2 should be able to see its own on-chain reputation without a separate tool, once the reputation system (issues 0318-0321) exists.

## Acceptance criteria

- [ ] The metrics endpoint (issue 0257) exposes current reputation.
- [ ] The CLI inspection commands (issue 0265) can query it on demand.
- [ ] If the eligibility floor from issue 0323 is enabled on the connected registry, the bot warns proactively if its own reputation is near or below it, rather than only discovering the problem when a claim starts failing.

## Files

- examples/keeper-bot-v2/src/metrics.*
