---
title: "feat(keeper-bot-v2): run against multiple signing accounts to parallelize submission"
labels: [keeper-bot, enhancement, advanced]
epic: E15
wave: 3
depends_on: [0253]
---

## Summary

A single Stellar account has one sequence number, which serializes submitted transactions from that account regardless of how much concurrency issue 0253 adds at the application level. A keeper wanting genuine submission parallelism needs more than one funded, signing-capable account to spread transactions across.

## Expected behaviour

The bot accepts a pool of signing accounts rather than a single KEEPER_SECRET_KEY, and the concurrency work from issue 0253 assigns concurrent claim/execute attempts to different accounts from the pool so they do not serialize on one account's sequence number.

## Acceptance criteria

- [ ] More than one signing account can be configured.
- [ ] Concurrent claims are distributed across the pool rather than all funneled through one account.
- [ ] Reward accounting correctly tracks which account executed which task, since keeper_balance is per-address on-chain and a pool means the keeper's total earnings are now split across several addresses.
- [ ] Documentation explains the operational implication: each account needs its own funding and its own withdrawal.

## Files

- (v2 package)/src/accounts.*
