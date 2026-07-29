---
title: "test(registry): confirm update_verifier's pause-gating is correct and matches the policy matrix"
labels: [testing, contract, good-first-issue]
epic: E04
wave: 2
depends_on: [0081]
---

## Summary

Wave 1's issue 0029 (later implemented and merged as the pause-policy-matrix test) established the rule of thumb documented on pause/unpause: anything opening new exposure is blocked, anything only returning already-owned value stays open. update_verifier (issue 0081) is a new entry point added after that policy was written down -- this issue makes sure it actually got a require_not_paused call and is added to the authoritative policy-matrix test, rather than being an entry point nobody remembered to gate.

## Expected behaviour

update_verifier calls require_not_paused before mutating. It is added to the pause-policy-matrix test (the one from the merged pause-policy PR) as a BLOCKED-while-paused entry point, since attaching or changing a verifier is a form of new exposure (it changes what proof a keeper will need going forward), consistent with how increase_reward and register_task are treated.

## Acceptance criteria

- [ ] update_verifier calls require_not_paused as its first check (or confirms it already does, if issue 0081's implementation included it).
- [ ] The policy-matrix test is extended to cover update_verifier explicitly.
- [ ] The pause doc comment's table (added by the pause-policy PR) is updated to list update_verifier.
- [ ] README FR-7 is updated to match.

## Files

- contracts/keeper-registry/src/lib.rs
- contracts/keeper-registry/src/test.rs
- README.md
