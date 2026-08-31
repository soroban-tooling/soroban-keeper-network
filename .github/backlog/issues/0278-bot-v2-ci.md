---
title: "chore(ci): add keeper-bot-v2 to the pipeline"
labels: [keeper-bot, tooling, good-first-issue]
epic: E15
wave: 3
depends_on: [0251]
---

## Summary

v2 needs the same CI coverage v1 has (the bot job in ci.yml), extended to cover its new database dependency for tests that need one.

## Acceptance criteria

- [ ] Build, lint, and test run in CI for the v2 package on relevant PRs.
- [ ] Database-dependent tests run against an ephemeral instance in CI, mirroring the approach from indexer issue 0233.
- [ ] Documented in docs/CI.md.

## Files

- .github/workflows/ci.yml
- docs/CI.md
