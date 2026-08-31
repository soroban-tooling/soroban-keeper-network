---
title: "feat(indexer): API key authentication for write-sensitive and high-cost endpoints"
labels: [indexer, security, intermediate]
epic: E14
wave: 3
depends_on: [0225, 0235]
---

## Summary

Most of the indexer's REST API (issue 0225) is public read-only data already visible on-chain, and does not need authentication. The bulk export (issue 0239) and any endpoint expensive enough to warrant per-consumer accountability beyond the rate limiting in issue 0235 are different: knowing who is calling matters for abuse response.

## Expected behaviour

An optional API key mechanism: unauthenticated requests get the default rate limit from issue 0235, requests with a valid key get a higher limit and access to cost-sensitive endpoints like bulk export, and key issuance and revocation are administrative operations, not self-service in this first version.

## Acceptance criteria

- [ ] Unauthenticated access continues to work for the core read endpoints at the default rate limit.
- [ ] A valid API key raises the effective rate limit and unlocks the export endpoint.
- [ ] A revoked key is rejected on the next request, not after some caching delay long enough to matter for abuse response.

## Files

- indexer/src/api/auth.rs
