---
title: "test(keeper-bot-v2): a test suite covering the new persistence and concurrency logic"
labels: [keeper-bot, testing, intermediate]
epic: E15
wave: 3
depends_on: [0252, 0253, 0254]
---

## Summary

v1's own test suite (wave 1 issue 0047, and the fixes to it in the wave that followed) covers the single-file bot's logic with a mocked RPC layer. v2 introduces genuinely new failure modes — concurrent workers racing on shared persisted state, a restart mid-round — that need their own dedicated coverage, not just a port of v1's tests.

## Expected behaviour

Tests specifically targeting: two concurrent workers never double-claiming the same task (building on issue 0253's guarantee), state correctly surviving a simulated restart (issue 0252), and the profitability check (issue 0254) correctly skipping an unprofitable task under a range of fee and reward combinations.

## Acceptance criteria

- [ ] Concurrency safety is tested with genuine concurrent execution, not just sequential calls that happen to not race.
- [ ] A simulated restart mid-round is tested and confirmed not to cause a double-claim or double-execute.
- [ ] Profitability boundary cases (exactly at the margin, just below, just above) are tested, mirroring the boundary-testing discipline the contract's own test suite uses.

## Files

- (v2 package)/test/
