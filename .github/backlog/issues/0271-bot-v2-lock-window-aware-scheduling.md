---
title: "feat(keeper-bot-v2): schedule retries around a task's actual lock window"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

The contract's lock_expired logic (contracts/keeper-registry/src/internal.rs) makes a Claimed task re-claimable once its lock_ledgers window elapses from the claim ledger. A keeper that loses a claim race today has no principled reason to check back on that specific task at any particular time; it just re-appears in the next full scan.

## Expected behaviour

When the bot observes a task is currently locked by another keeper, it records the task's computed unlock ledger (claim_ledger plus lock_ledgers, the same arithmetic required_ttl_ledgers-adjacent logic in the contract itself uses) and schedules a targeted re-check near that time, rather than relying solely on the next full poll to notice.

## Acceptance criteria

- [ ] A locked task's unlock ledger is computed correctly from its on-chain claim_ledger and lock_ledgers.
- [ ] The bot re-checks a tracked locked task at or shortly after its computed unlock point, without needing a full re-scan to first rediscover it.
- [ ] This scheduling is additive to, not a replacement for, the regular poll cycle, so a task the bot has not seen before is still discovered normally.

## Files

- (v2 package)/src/scheduling.*
