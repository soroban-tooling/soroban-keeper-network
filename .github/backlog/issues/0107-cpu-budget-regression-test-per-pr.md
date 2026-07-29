---
title: "test(registry): add a CPU-instruction regression test for the hottest entry points"
labels: [testing, contract, intermediate]
epic: E05
wave: 2
depends_on: [0100]
---

## Summary

Issue 0100 adds a CI job that reports per-entry-point resource cost for visibility. This issue goes one step further for the two or three entry points most likely to be called under real load (claim_task, execute_task) by pinning an actual regression test: a hard ceiling on CPU instructions consumed, asserted in the test suite itself rather than only surfaced in a CI summary a reviewer has to notice.

## Expected behaviour

A test per hot entry point that measures instructions consumed (via the same budget-tracking API 0100 uses) and asserts it stays under a generously-padded ceiling above the currently-measured value. The ceiling should be loose enough that ordinary, justified changes do not trip it, but tight enough to catch an accidental regression -- for example, a refactor that starts calling bump_instance twice by mistake, or a verifier integration that grows execute_task's cost by an order of magnitude without anyone noticing.

## Acceptance criteria

- [ ] At least claim_task and execute_task have a pinned ceiling test.
- [ ] The ceiling and the reasoning for its margin are documented in a comment.
- [ ] A deliberate regression (temporarily, to prove the test works) actually fails it during development -- remove the deliberate regression before merging, but confirm the test has teeth.

## Files

- contracts/keeper-registry/src/test.rs
