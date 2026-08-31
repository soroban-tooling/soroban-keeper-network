---
title: "docs(indexer): epic retrospective and handoff to consuming epics"
labels: [indexer, docs, good-first-issue]
epic: E14
wave: 3
depends_on: [0218, 0225, 0226, 0248]
---

## Summary

Closes epic E14. Written once the indexer is deployed and serving real queries, this records what the epic actually built against what issue 0218 originally designed, and hands off a clear contract to the epics that will consume it: the web dashboard (E17), the keeper bot v2 work (E15) if it wants to read indexed history instead of scanning events itself, and any future CLI tooling (E16).

## Expected behaviour

A short document naming: any place the implementation diverged from the original design and why, the stable API surface consuming epics should build against, and any known gaps or deferred work (from issues like 0237's multi-contract question or 0247's retention policy, if either was deferred rather than resolved).

## Acceptance criteria

- [ ] Divergences from the original design in issue 0218 are named and justified.
- [ ] The stable API surface is stated plainly enough that E15, E16, and E17 can reference it without re-reading every issue in this epic.
- [ ] Any deferred question is named as deferred, not silently dropped.

## Files

- docs/INDEXER_DESIGN.md
