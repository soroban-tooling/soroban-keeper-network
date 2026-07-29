---
title: "design(registry): version the IKeeperVerifier interface itself"
labels: [contract, docs, advanced]
epic: E04
wave: 2
depends_on: [0071]
---

## Summary

The registry contract has its own VERSION constant for detecting ABI changes (see issue 0096). Once third parties start writing verifier contracts against the interface from issue 0071, that interface needs the same discipline -- a verifier written against v1 of the interface should not silently misbehave if the registry later calls it with a v2 calling convention.

## Expected behaviour

The IKeeperVerifier interface itself carries a version marker (a constant the verifier exposes, or a version argument in the call), and the registry's execute_task checks it before calling verify, rejecting with a typed error rather than calling a verifier written against an incompatible interface version.

## Suggested approach

Look at how the registry contract's own VERSION function is exposed and consumed (issue 0096) and mirror that pattern for symmetry -- a verifier exposing verifier_interface_version() that execute_task checks once, cached or re-checked per call depending on how expensive that turns out to be.

## Acceptance criteria

- [ ] Interface version is checkable by the registry before delegating to verify.
- [ ] A test simulates a verifier reporting an incompatible version and confirms execute_task rejects it cleanly rather than calling verify anyway.
- [ ] Documented in docs/VERIFIER_DESIGN.md alongside the rest of the interface spec.

## Files

- docs/VERIFIER_DESIGN.md
- contracts/keeper-registry/src/lib.rs
