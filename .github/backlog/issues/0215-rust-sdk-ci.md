---
title: "chore(ci): add the Rust SDK crate to the pipeline"
labels: [rust-sdk, tooling, good-first-issue]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The Rust SDK crate has no CI coverage yet. Once issues 0198 through 0212 land it has real logic (event decoding, retry classification, a transaction builder) worth testing on every push, the same way keeper-registry itself is covered by the existing ci.yml.

## Expected behaviour

The crate is added to the workspace's required jobs: format check, cargo test, and clippy, following the exact split between required and advisory jobs docs/CI.md already documents for keeper-registry, rather than inventing a separate policy for this one crate.

## Suggested approach

If the crate needs a live or mocked RPC endpoint to run its integration tests, follow whatever pattern the fuzz crate or the keeper-registry test suite already uses for isolating network-independent tests from ones that need a real environment, so CI does not silently depend on an external testnet being reachable.

## Acceptance criteria

- [ ] rust-sdk is built and tested in CI on every PR touching it.
- [ ] Format and clippy match the required/advisory split already documented in docs/CI.md.
- [ ] No test in the required path depends on a live network call that could make CI flaky for reasons unrelated to the code under test.

## Files

- .github/workflows/ci.yml
- docs/CI.md
