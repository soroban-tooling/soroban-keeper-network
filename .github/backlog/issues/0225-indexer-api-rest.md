---
title: "feat(indexer): a REST API over the ingested data"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0220, 0221, 0222]
---

## Summary

The schemas from issues 0220 through 0222 are queryable directly against the database, but a browser-based consumer (the web dashboard, epic E17) and third-party integrators need an HTTP API rather than direct database access.

## Expected behaviour

Endpoints matching the query shapes issue 0218 identified as real consumer needs: a task by id with full history, tasks by owner, tasks by keeper, current admin config, and a paginated recent-events feed. Response shapes should be stable and versioned so a dashboard built against v1 does not silently break when the API evolves.

## Suggested approach

Do not expose the raw database schema directly; define response types independent of the storage layer so a future schema migration (issue 0218's choices are not permanent) does not force every API consumer to update in lockstep.

## Acceptance criteria

- [ ] Endpoints cover task-by-id, tasks-by-owner, tasks-by-keeper, current admin config, and a paginated event feed.
- [ ] Responses are versioned (a path prefix or header) from the first release, not retrofitted later.
- [ ] Pagination on the event feed uses a stable cursor, not an offset that shifts if new events are ingested between pages.
- [ ] OpenAPI or equivalent schema documentation is generated from the same types the handlers use, not hand-maintained separately.

## Files

- indexer/src/api/
- indexer/openapi.yaml
