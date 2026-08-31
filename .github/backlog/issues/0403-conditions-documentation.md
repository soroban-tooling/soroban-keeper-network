---
title: "docs: task-conditions integration guide for dApp authors"
labels: [docs, intermediate]
epic: E10
wave: 4
depends_on: [0390, 0397]
---

## Summary

Once the core mechanism and the reference price-threshold condition (issue 0397) exist, dApp authors registering tasks need a document explaining when to attach a condition, how to write a custom one against the interface from issue 0390, and the resource-cost and failure-mode tradeoffs from issues 0395 and 0396 — following the exact structure epic E04's issue 0088 established for its own (never-shipped) verifier integration guide, since the two features are close enough in shape that the same document structure serves readers well.

## Acceptance criteria

- [ ] A dApp author can decide, correctly, whether their use case needs a condition versus relying on a keeper bot's own off-chain filtering logic.
- [ ] The reference price-threshold condition is documented with a copy-pasteable registration example.
- [ ] The panic-isolation and resource-cost implications from issues 0395 and 0396 are stated plainly, not buried.

## Files

- docs/TASK_CONDITIONS.md
