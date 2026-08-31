---
title: "feat(keeper-bot-v2): support external secret managers for the signing key"
labels: [keeper-bot, security, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1 reads KEEPER_SECRET_KEY as a plain environment variable, acceptable for an educational example but not for an operator running real funds in production, especially once issue 0255's multi-account support means several keys need managing at once.

## Expected behaviour

Support for sourcing signing keys from at least one external secret manager (a cloud provider's secret store, or a local encrypted-at-rest option) as an alternative to a plain environment variable, with the environment-variable path kept as the default for local development and the existing example's simplicity.

## Acceptance criteria

- [ ] At least one external secret source is supported end to end.
- [ ] The plain environment-variable path continues to work unchanged for local development.
- [ ] No code path ever logs a secret key in full, including in error messages, matching the redaction discipline from issue 0217's Rust SDK error work applied here in JavaScript.

## Files

- (v2 package)/src/secrets.*
