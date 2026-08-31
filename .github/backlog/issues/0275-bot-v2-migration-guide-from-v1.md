---
title: "docs(keeper-bot-v2): a migration guide for operators running v1"
labels: [keeper-bot, docs, good-first-issue]
epic: E15
wave: 3
depends_on: [0250, 0252]
---

## Summary

An operator currently running v1 in production needs a clear path to v2: what changes, what stays the same, what state (if any) can be carried over, and what the operational differences are (a database dependency now exists, per issue 0252).

## Acceptance criteria

- [ ] Every v1 configuration value's v2 equivalent (or removal, if superseded) is documented.
- [ ] The document states plainly whether v1's in-memory outcome cache can be seeded into v2's persistent schema or whether v2 simply starts fresh.
- [ ] New operational requirements (database, and any others introduced by this epic) are called out explicitly, not left for the operator to discover at deploy time.

## Files

- docs/KEEPER_BOT_V2_MIGRATION.md
