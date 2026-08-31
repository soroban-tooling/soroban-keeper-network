---
title: "chore(indexer): a migration tool for schema changes"
labels: [indexer, tooling, good-first-issue]
epic: E14
wave: 3
depends_on: [0220, 0221, 0222]
---

## Summary

The schemas from issues 0220 through 0222 will change over the life of this project. Without a migration tool, every schema change becomes a manual, undocumented, and unrepeatable operation against whatever database instances happen to exist.

## Expected behaviour

Versioned migration files applied in order, with a record of which migrations have run against a given database, so deploying a schema change is running one command rather than hand-editing tables.

## Suggested approach

Use whatever migration tooling is idiomatic for the language and database chosen in issue 0218 rather than hand-rolling one; this is a solved problem in most ecosystems and a custom implementation would only add maintenance burden.

## Acceptance criteria

- [ ] A fresh database can be brought to the current schema with one command.
- [ ] An existing database with data can be migrated forward without data loss.
- [ ] Migration files are checked into the repository and reviewed the same as any other code change.

## Files

- indexer/migrations/
