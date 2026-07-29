---
title: "feat(verifiers): publish a minimal test harness for third-party verifier authors"
labels: [testing, docs, intermediate]
epic: E04
wave: 2
depends_on: [0071, 0083, 0084]
---

## Summary

Issues 0083-0087 built test-only mock verifiers (always-approve, always-reject, panicking, expensive) inside the registry's own test.rs to exercise execute_task's side of the integration. A third-party author writing a real verifier has no equivalent tooling to test their contract against a realistic registry without standing up the full registry test harness themselves from scratch.

## Expected behaviour

A small, published (not test-only) harness -- perhaps contracts/verifiers/test-support/ or documented directly in docs/VERIFIERS.md as a copy-pasteable snippet -- showing a third-party verifier author how to deploy a minimal registry instance, register a task with their verifier attached, and drive it through claim/execute to confirm their verify function is called with the arguments they expect.

## Acceptance criteria

- [ ] A third-party author with no prior knowledge of this repo's test.rs internals can follow the harness to test a new verifier end to end.
- [ ] Uses the same RegistryHarness-style pattern already established for the contract's own tests, but packaged for external reuse rather than buried in #[cfg(test)] code.
- [ ] Linked from docs/VERIFIERS.md's integration guide (issue 0088).

## Files

- contracts/verifiers/test-support/src/lib.rs
- docs/VERIFIERS.md
