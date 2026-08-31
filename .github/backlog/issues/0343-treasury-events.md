---
title: "feat(treasury): events for every distribution and configuration change"
labels: [contract, enhancement, good-first-issue]
epic: E08
wave: 4
depends_on: [0340, 0342]
---

## Summary

Adds the event coverage the treasury contract needs for auditability, matching the registry's own convention of emitting rather than only logging.

## Acceptance criteria

- [ ] A distribution event carries the total amount and the per-recipient breakdown.
- [ ] Recipient-management events (added, removed, reweighted) carry enough detail to reconstruct the full configuration history from events alone.
- [ ] README (or a new treasury-specific document) documents the event topic pairs, following the registry's existing event table format.

## Files

- contracts/treasury/src/lib.rs
