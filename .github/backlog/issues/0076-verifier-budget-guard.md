---
title: "feat(registry): document and, if possible, bound the resource budget a verifier call may consume"
labels: [contract, security, advanced]
epic: E04
wave: 2
depends_on: [0074]
---

## Summary

The cross-contract call to a task's verifier (0074) is charged against the same transaction budget as everything else `execute_task` does. An expensive or deliberately wasteful verifier could make executing a task cost far more than the keeper anticipated when it claimed the task, eating into or exceeding the profit margin the keeper-bot's profitability check (wave 1 issue 0035) assumed.

## Expected behaviour

At minimum: document clearly, in the verifier interface spec (0071) and in end-user-facing docs, that the calling keeper bears the full resource cost of whatever verifier the task owner attached, and that a keeper bot should be able to inspect or estimate this cost *before* claiming (not just before executing) so it can factor it into a profitability decision.

Investigate whether Soroban exposes any mechanism to cap a sub-call's resource consumption from the caller's side (distinct from the overall transaction budget, which the keeper already controls via simulation). If such a mechanism exists, use it; if not, this issue's deliverable is the documentation and a recommendation for the keeper-bot side (0091 covers the bot's task-selection logic).

## Suggested approach

Start with Soroban's simulation output — `simulateTransaction` already reports resource usage for the whole transaction, including sub-calls. A keeper bot could simulate an `execute_task` call *before* committing to claim, to estimate the verifier's cost. Confirm this actually works for a `Claimed`-status precondition (simulating against a task the bot hasn't claimed yet) or whether it requires the bot to have already claimed, which changes the ordering of the profitability check.

## Acceptance criteria

- [ ] Documents who bears the verifier's resource cost and when a keeper can find out how much that is.
- [ ] States plainly whether a hard per-call budget cap is technically possible on Soroban today, with evidence.
- [ ] If a cap is possible, implement it; if not, hand off a clear requirement to 0091 (bot-side task selection).

## Files

- `docs/VERIFIER_DESIGN.md`
- `contracts/keeper-registry/src/lib.rs`
