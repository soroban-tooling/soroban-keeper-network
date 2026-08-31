---
title: "fix(keeper-bot-v2): simulate every state-mutating call before submitting, not just claim_task"
labels: [keeper-bot, correctness, good-first-issue]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

The is_claimable pre-check from wave 1's issue 0034 avoids wasting a submission on an already-claimed task, but nothing currently simulates execute_task or withdraw_rewards before submitting them, meaning a doomed call (a task that moved out of Claimed status between rounds, a withdrawal attempted with zero balance) still pays the submission cost of finding that out on-chain rather than for free via simulation.

## Expected behaviour

Every state-mutating call the bot makes is simulated first, and a simulation failure is treated as a skip (logged, not submitted) rather than proceeding to submission and letting the chain reject it.

## Acceptance criteria

- [ ] execute_task and withdraw_rewards are simulated before submission, matching the pattern claim_task's pre-check already established.
- [ ] A simulation failure never results in a submitted transaction for that call.
- [ ] The added simulation calls are accounted for in the profitability calculation from issue 0254, since they are not free in wall-clock time even though they cost no fee.

## Files

- (v2 package)/src/submit.*
