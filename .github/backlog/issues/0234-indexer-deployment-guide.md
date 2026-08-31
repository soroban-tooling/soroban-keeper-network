---
title: "docs(indexer): write the deployment guide"
labels: [indexer, docs, good-first-issue]
epic: E14
wave: 3
depends_on: [0219, 0223, 0232]
---

## Summary

Once the indexer can be built, backfilled, and migrated, an operator needs a document describing how to actually run one: required environment, database provisioning, running the initial backfill, and what a healthy steady state looks like.

## Suggested approach

Follow docs/DEPLOYING.md's existing structure and troubleshooting-section convention (issue 0045, wave 1) rather than inventing a new document shape for this component.

## Acceptance criteria

- [ ] Covers provisioning, configuration, initial backfill, and steady-state operation.
- [ ] Includes a troubleshooting section for at minimum: backfill stuck partway, ingestion lag growing, database connection failures.
- [ ] Cross-references docs/INDEXER_DESIGN.md rather than restating its content.

## Files

- docs/INDEXER_DEPLOYMENT.md
