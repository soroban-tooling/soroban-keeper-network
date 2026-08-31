---
title: "chore(keeper-bot-v2): scaffold the v2 package"
labels: [keeper-bot, tooling, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

Stands up the v2 package (location and language per issue 0250's decision) with its dependency management, lint, and test tooling wired, but no keeper logic yet — this epic's equivalent of issue 0051's fuzz-harness-setup and issue 0219's indexer scaffolding.

## Acceptance criteria

- [ ] Package builds and its (currently empty) test suite runs.
- [ ] Lint configuration is in place from the start, following the same non-negotiable-but-small ruleset philosophy the v1 eslint.config.js states in its own comment.
- [ ] README states clearly that this is v2, aimed at operators, and points newcomers at examples/keeper-bot instead.

## Files

- (location per issue 0250)
