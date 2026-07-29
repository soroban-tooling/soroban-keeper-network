---
title: "test(fuzz): fuzz every entry point against an uninitialized registry"
labels: [testing, contract, good-first-issue]
epic: E03
wave: 2
depends_on: [0051]
---

## Summary

Wave 1's issue 0008 replaced panicking `.expect("not initialized")` calls with a typed NotInitialized error across every entry point that depends on configured state. The wave-1 test suite covers this per-function with hand-written cases. This issue adds a fuzz target that calls every mutating entry point, in random order, against a never-initialized registry, to catch any function issue 0008's manual sweep might have missed -- particularly useful if a new entry point (batch registration from epic E05, for instance) is added later and its author forgets this class of guard.

## Expected behaviour

A fuzz target that, for a freshly-deployed but never-initialized registry, calls each public mutating function with fuzzed arguments and asserts every single one returns a typed KeeperError (NotInitialized or another applicable one, such as TaskNotFound for functions that check task existence before configuration) -- never a panic, never an unhandled host trap.

## Acceptance criteria

- [ ] Every current mutating entry point is covered, enumerated explicitly (not just "call random functions") so a newly-added function is trivially added to the list rather than silently skipped.
- [ ] No panic found across the fuzzed argument space for any covered function.
- [ ] A comment instructs future contributors adding a new entry point to add it to this target's coverage list.

## Files

- fuzz/fuzz_targets/uninitialized_registry.rs
