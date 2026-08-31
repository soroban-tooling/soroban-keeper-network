---
title: "security(indexer): review the public API surface before general availability"
labels: [indexer, security, advanced]
epic: E14
wave: 3
depends_on: [0225, 0226, 0235, 0242]
---

## Summary

Before the indexer's REST API, WebSocket feed, rate limiting, and authentication (issues 0225, 0226, 0235, 0242) are treated as production-ready, they need a dedicated security pass, following the threat-modeling discipline epic E19 establishes for the contract itself.

## Expected behaviour

A review covering at minimum: SQL injection surface in any query built from user-supplied filters, whether an unauthenticated client can trigger disproportionately expensive queries despite rate limiting, WebSocket connection exhaustion, and whether any endpoint leaks more data than intended (an address's full activity feed, for instance, should be exactly as public as the on-chain data it reflects, no more and no less).

## Acceptance criteria

- [ ] Each concern above is explicitly addressed with a finding or a confirmation it does not apply.
- [ ] Any finding is fixed or has a filed, scoped follow-up issue before this is closed.
- [ ] The review's findings and resolutions are documented, not just fixed silently, so the reasoning survives for a future audit.

## Files

- docs/INDEXER_SECURITY_REVIEW.md
