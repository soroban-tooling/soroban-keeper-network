---
title: "feat(indexer): rate limit the public REST and WebSocket APIs"
labels: [indexer, security, intermediate]
epic: E14
wave: 3
depends_on: [0225, 0226]
---

## Summary

Once the REST API (issue 0225) and WebSocket feed (issue 0226) are public, they are a target for abusive query volume that could degrade service for legitimate consumers or drive up database load and hosting cost.

## Expected behaviour

Per-client rate limits on both the REST API and new WebSocket connections, with limits generous enough for normal dashboard and keeper-bot usage but bounded against a single client monopolizing capacity.

## Acceptance criteria

- [ ] Both REST and WebSocket paths are rate limited per client (by API key or IP, whichever issue 0218 or this issue's implementation decides is appropriate).
- [ ] A client that exceeds its limit receives a clear, typed error (HTTP 429 or equivalent), not a silent drop or a generic failure.
- [ ] Limits are configurable without a code change, since the right threshold will need tuning after real usage is observed.

## Files

- indexer/src/api/rate_limit.rs
