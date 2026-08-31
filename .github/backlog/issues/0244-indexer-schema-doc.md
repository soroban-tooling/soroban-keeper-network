---
title: "docs(indexer): publish the schema reference"
labels: [indexer, docs, good-first-issue]
epic: E14
wave: 3
depends_on: [0220, 0221, 0222]
---

## Summary

Once the schemas from issues 0220 through 0222 exist as code and migrations, they need a human-readable reference distinct from the raw SQL, so a consumer deciding whether to query the API or the database directly can see the full shape at a glance.

## Acceptance criteria

- [ ] Every table, its columns, and their meaning are documented.
- [ ] The relationship between raw event tables and derived current-state views is explained.
- [ ] Kept in sync with the actual schema; the migration tooling from issue 0232 or a CI check should catch drift between this document and the real schema where practical.

## Files

- docs/INDEXER_SCHEMA.md
