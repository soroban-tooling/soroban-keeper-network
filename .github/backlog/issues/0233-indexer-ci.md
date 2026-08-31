---
title: "chore(ci): add the indexer service to the pipeline"
labels: [indexer, tooling, good-first-issue]
epic: E14
wave: 3
depends_on: [0219]
---

## Summary

The indexer needs the same CI coverage every other component in this repository has: format, lint, and a test suite that runs on every relevant PR, following the required/advisory split docs/CI.md documents.

## Acceptance criteria

- [ ] Indexer build and test run in CI on PRs touching its directory.
- [ ] Database-dependent tests run against an ephemeral database in CI (a service container or equivalent), not a shared instance.
- [ ] Documented in docs/CI.md alongside the other jobs.

## Files

- .github/workflows/ci.yml
- docs/CI.md
