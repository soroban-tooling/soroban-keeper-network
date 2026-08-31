---
title: "fix(indexer): normalize Stellar addresses consistently across storage and queries"
labels: [indexer, correctness, good-first-issue]
epic: E14
wave: 3
depends_on: [0220]
---

## Summary

Stellar addresses have more than one valid string encoding path depending on the source library and version. If ingestion stores an address in one form and a query compares against another, a lookup can silently miss rows that actually belong to the same address.

## Expected behaviour

Every address is normalized to one canonical form at the point of ingestion and at the point of query construction, with a single shared normalization function used by both paths so they cannot drift.

## Acceptance criteria

- [ ] A single normalization function is used by every ingestion and query path that handles an address.
- [ ] A test constructs the same underlying address via two different valid encodings and confirms both resolve to the same stored and queried identity.
- [ ] Existing schemas and queries from issues 0220 through 0229 are audited against this function and corrected if any bypassed it.

## Files

- indexer/src/address.rs
