---
title: "fix(keeper-bot-v2): preserve v1's graceful shutdown guarantee under concurrency"
labels: [keeper-bot, correctness, intermediate]
epic: E15
wave: 3
depends_on: [0253]
---

## Summary

v1's SIGINT/SIGTERM handling drains a single in-flight round before exiting. Once issue 0253 introduces concurrent task processing within a round, shutdown needs to drain every in-flight concurrent worker, not just wait for one serial round to finish, or a shutdown signal could kill a worker mid-submission.

## Expected behaviour

A shutdown signal stops new work from starting, waits for all currently in-flight concurrent workers to reach a safe stopping point (after their current submission completes and its outcome is persisted per issue 0252), then exits, with the same bounded maximum wait discipline as the indexer's graceful shutdown from issue 0243.

## Acceptance criteria

- [ ] A shutdown signal during concurrent processing waits for every in-flight worker, not just one.
- [ ] No worker is killed mid-submission; each either completes and persists its outcome or is allowed to finish before shutdown proceeds.
- [ ] A bounded maximum drain time prevents a stuck worker from blocking shutdown indefinitely.

## Files

- (v2 package)/src/shutdown.*
