---
title: "feat(indexer): alert on new proposals and closing voting windows"
labels: [indexer, enhancement, good-first-issue]
epic: E09
wave: 4
depends_on: [0376, 0240]
---

## Summary

A token holder wants to know when a new proposal is created and when a voting window they have not yet participated in is about to close, using the alerting infrastructure the indexer already built for high-signal registry events in issue 0240.

## Acceptance criteria

- [ ] New-proposal and voting-window-closing-soon rules are added to the existing alert-rule mechanism from issue 0240, not a separate parallel notification system.
- [ ] A test confirms both rules fire correctly against the governance events ingested in issue 0376.

## Files

- indexer/src/alerts.rs
