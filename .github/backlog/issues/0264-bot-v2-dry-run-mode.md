---
title: "feat(keeper-bot-v2): a dry-run mode that logs decisions without submitting transactions"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E15
wave: 3
depends_on: [0254, 0261]
---

## Summary

An operator tuning profitability thresholds (issue 0254) or prioritization (issue 0261) needs to see what the bot would do under a candidate configuration before risking real fees finding out the hard way.

## Expected behaviour

A dry-run flag that runs the full evaluation and ranking pipeline, logging every decision (claim, skip, and why) exactly as a live round would, without submitting any transaction.

## Acceptance criteria

- [ ] Dry-run produces identical decisions to what a live round would make given the same on-chain state, verified by comparing dry-run output against a live test run against the same fixture data.
- [ ] No transaction is submitted and no signing key is required to run in this mode.
- [ ] Output is structured enough (not just free-text logs) that an operator can diff two configurations' dry-run output to see what changed.

## Files

- (v2 package)/src/loop.*
