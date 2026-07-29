---
title: "docs(architecture): add invariant I-8 -- a verifier can gate a payout but never move funds itself"
labels: [docs, security, intermediate]
epic: E04
wave: 2
depends_on: [0089, 0050]
---

## Summary

Issue 0050 documented seven invariants (I-1 through I-7) before epic E04's verifier concept existed. Issue 0089's security-considerations write-up reasons informally about whether a verifier could ever move funds itself rather than merely gating whether the registry's own crediting logic runs. This issue promotes that reasoning into a numbered, permanent invariant in docs/ARCHITECTURE.md, in the same rigorous style as I-1 through I-7 -- precise statement, enforcing code, and a description of what change would break it.

## Expected behaviour

A new "I-8: Verifier trust boundary" section stating precisely: a task's attached verifier can only return a boolean (or fail) from execute_task's perspective; it has no capability, by construction, to transfer tokens, credit a keeper balance, or mutate any Task field. State what in the code enforces this (the fact that the verifier call happens before any state mutation and its return value only gates an if-branch, per issue 0074's implementation) and what a future change could do to violate it (for example, passing a mutable reference or capability to the verifier instead of just calling it for a boolean).

## Acceptance criteria

- [ ] I-8 is added to docs/ARCHITECTURE.md in the same format as I-1 through I-7.
- [ ] Cross-referenced from issue 0089's security-considerations document rather than duplicating the reasoning.
- [ ] The "breaks if" clause is concrete enough that a future PR reviewer could recognize a violation from the description alone.

## Files

- docs/ARCHITECTURE.md
