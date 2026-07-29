---
title: "test(fuzz): fuzz batch_register_tasks entry count and per-entry parameter mix"
labels: [testing, contract, intermediate]
epic: E05
wave: 2
depends_on: [0098, 0051]
---

## Summary

Extends epic E03's fuzzing infrastructure (issue 0051's harness) to the batch registration entry point once it exists, covering both the number of entries in a batch and the parameter mix within each entry.

## Expected behaviour

A fuzz target that generates a variable-length vector of TaskParams (including the degenerate empty-batch and single-entry cases) with fuzzed reward, deadline, and lock/ttl values per entry, and asserts the contract never panics regardless of batch shape, and that every rejection is a typed KeeperError.

## Acceptance criteria

- [ ] Covers batch sizes from zero entries up to well past the practical ceiling from issue 0104.
- [ ] Confirms the all-or-nothing behavior holds under fuzzing, not just in the hand-written unit tests.
- [ ] Seeded with the boundary values from 0104's ceiling test, per the corpus-seeding convention from issue 0067.

## Files

- fuzz/fuzz_targets/batch_register_tasks.rs
