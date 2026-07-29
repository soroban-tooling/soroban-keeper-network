---
title: "feat(registry): implement claim_first_available if issue 0099 recommends it"
labels: [contract, enhancement, advanced]
epic: E05
wave: 2
depends_on: [0099]
---

## Summary

Conditional on issue 0099's feasibility study recommending the claim_first_available alternative over a naive batch claim: implement it. If 0099 concluded something else, this issue should be closed as not applicable and a new issue filed matching whatever was actually recommended -- do not force this specific API onto a different conclusion.

## Expected behaviour

claim_first_available(e, keeper, candidates: Vec<u64>) -> Result<u64, KeeperError> that tries each candidate task id in order and returns the id of the first one it successfully claims, or a typed error if none of them were claimable. This gives a keeper bot a way to express "I can do any of these N tasks, give me whichever is still available" in one call, without the atomicity problem a true batch claim has (per 0099's reasoning).

## Suggested approach

Internally this can just loop calling the same logic claim_task already uses, short-circuiting on the first success -- it does not need new storage or a new status. The main design question is what to return when every candidate is unavailable: a single typed error is probably right, but consider whether the caller benefits from knowing why each one failed (already claimed vs deadline passed vs not found) versus that being unnecessary complexity for a keeper bot that will just move on to the next polling round regardless.

## Acceptance criteria

- [ ] Successfully claims the first available candidate and returns its id.
- [ ] Returns a typed error (not a panic) when none are available.
- [ ] A test with a mix of already-claimed, past-deadline, and available candidates confirms it picks the right one.
- [ ] Keeper-bot example (or a follow-up issue against it) is updated to use this instead of trying candidates one at a time in separate transactions, if that is in fact cheaper -- verify the resource cost actually improves before claiming it as a win.

## Files

- contracts/keeper-registry/src/lib.rs
- contracts/keeper-registry/src/test.rs
