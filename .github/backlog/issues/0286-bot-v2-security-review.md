---
title: "security(keeper-bot-v2): review secret handling and the CLI/admin surface before release"
labels: [keeper-bot, security, advanced]
epic: E15
wave: 3
depends_on: [0268, 0265]
---

## Summary

v2 introduces a materially larger attack surface than v1: a database (issue 0252), external secret manager integration (issue 0268), CLI inspection commands (issue 0265), and possibly a metrics or admin endpoint (issue 0257). This issue is a dedicated security pass before any of it is called production-ready, mirroring the discipline the indexer epic applied in issue 0248.

## Expected behaviour

A review covering: whether the CLI inspection commands or metrics endpoint could leak a secret or signing capability if exposed on a network interface rather than kept local-only, whether the persisted state schema itself needs encryption at rest given it may reveal a keeper's strategy or timing, and whether the secret-manager integration correctly avoids ever writing a plaintext key to disk or logs.

## Acceptance criteria

- [ ] Each concern above is explicitly addressed with a finding or a confirmation it does not apply.
- [ ] Any finding is fixed or has a filed, scoped follow-up before this closes.
- [ ] The review is documented, not just fixed silently.

## Files

- docs/KEEPER_BOT_V2_SECURITY_REVIEW.md
