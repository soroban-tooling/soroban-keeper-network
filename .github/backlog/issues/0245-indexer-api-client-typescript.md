---
title: "feat(indexer): a thin TypeScript client for the indexer API"
labels: [indexer, ts-sdk, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0225, 0226]
---

## Summary

The web dashboard (epic E17) and any browser-based integrator need a typed client for the indexer's REST and WebSocket APIs, the same way the TypeScript SDK (epic E12) provides one for the registry contract itself. This is a distinct concern from the registry SDK — it talks to the indexer's HTTP API, not the chain directly — and should be its own package rather than folded into the registry SDK.

## Expected behaviour

Typed methods for every REST endpoint from issue 0225 and a typed subscription helper for the WebSocket feed from issue 0226, generated from or kept in sync with the OpenAPI schema issue 0225 produces, so the two cannot silently drift.

## Acceptance criteria

- [ ] Every REST endpoint has a corresponding typed client method.
- [ ] The WebSocket subscription helper correctly types events per the shared event types from issue 0226.
- [ ] Types are generated from or validated against the OpenAPI schema in CI, catching drift automatically rather than relying on a contributor to notice.

## Files

- indexer-client/src/
