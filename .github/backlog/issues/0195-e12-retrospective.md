---
title: "docs: epic E12 retrospective and readiness check for epic E14's indexer consumers"
labels: [docs, good-first-issue]
epic: E12
wave: 3
depends_on: [0165, 0192, 0194]
---

## Summary

Closes out the TypeScript SDK epic's first 45 issues (0151-0194), in the same retrospective style as wave 2's epic closeouts (issues 0118, 0141, 0142). Also checks a forward dependency: epic E14 (Event Indexer, later in this wave) will likely want to reuse this SDK's typed event decoders (issue 0167) rather than reimplementing them, and this issue confirms that reuse is actually practical (the decoders are exported and documented well enough to be depended on by a separate package) before E14 is drafted.

## Expected behaviour

A summary section covering: what shipped (client, transaction builders, React hooks, docs, the keeper-bot migration), what conventions were established (issues 0165, 0192) that later epics should follow rather than reinvent, and an explicit note on whether epic E14 should depend on `packages/sdk-ts`'s event decoders directly or fork them -- with a recommendation.

## Acceptance criteria

- [ ] Every major issue cluster (client methods, transaction builders, React hooks, testing, docs, CI) is represented in the summary.
- [ ] The E14 dependency question has an explicit recommendation, not left implicit for whoever drafts wave 3's indexer issues to guess at.

## Files

- packages/sdk-ts/RETROSPECTIVE.md
