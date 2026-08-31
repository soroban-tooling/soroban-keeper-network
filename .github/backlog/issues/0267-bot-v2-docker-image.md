---
title: "chore(keeper-bot-v2): publish a container image for deployment"
labels: [keeper-bot, tooling, good-first-issue]
epic: E15
wave: 3
depends_on: [0251]
---

## Summary

An operator running v2 in production wants a container image rather than cloning the repository and running from source, especially once v2 has a database dependency (issue 0252) that also needs orchestrating.

## Acceptance criteria

- [ ] A Dockerfile (or equivalent) builds a working image.
- [ ] The image does not bake in any secret; the signing key and other secrets are supplied at runtime via environment variables or a mounted secret, matching the .env.example pattern v1 already uses.
- [ ] A docker-compose or equivalent example demonstrates running the bot alongside its database dependency.

## Files

- (v2 package)/Dockerfile
- (v2 package)/docker-compose.yml
