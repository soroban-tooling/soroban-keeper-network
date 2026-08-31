---
title: "design(keeper-bot-v2): defer verifier-aware proof generation until the contract feature exists"
labels: [keeper-bot, docs, good-first-issue]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

Several earlier backlog issues (0090, 0091, and others in the 0102-0140 range) describe keeper-bot support for tasks gated by an on-chain verifier. As of this writing, the registry contract has no verifier field on Task and no update_verifier or verify entry point; only a placeholder IncompatibleVerifierInterface error variant exists in errors.rs with no code path that produces it. Those earlier issues describe a feature that was designed (docs/VERIFIER_DESIGN.md, docs/VERIFIERS.md exist) but never actually implemented in the deployed contract.

## Expected behaviour

This issue is a deliberate placeholder, not an implementation: it records that verifier-aware proof generation in the bot is blocked on the contract-side feature actually landing, points at the original design issues for when that work resumes, and prevents v2 from silently building bot-side support for a contract capability that does not exist, which would be untestable and would give a false impression the feature is further along than it is.

## Acceptance criteria

- [ ] The dependency on the unimplemented contract feature is stated explicitly, with a reference to the specific missing pieces (Task.verifier field, update_verifier entry point, the actual verify cross-contract call in execute_task).
- [ ] No bot code is written against the unimplemented interface as part of this issue.
- [ ] When the contract-side feature is actually implemented, this issue is superseded by the real proof-generation work, referencing whichever issue numbers cover that at the time.

## Files

- docs/KEEPER_BOT_V2_DESIGN.md
