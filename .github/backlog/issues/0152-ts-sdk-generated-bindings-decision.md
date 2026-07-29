---
title: "design(sdk-ts): decide between Soroban CLI-generated bindings and a hand-written client"
labels: [docs, intermediate]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

`stellar contract bindings typescript` (the Soroban CLI's own codegen) can generate a typed client directly from a deployed contract's WASM. This issue decides whether the SDK should be built on top of that generated output (thin wrapper, less maintenance, but tied to CLI tooling and regeneration on every contract change) or hand-written against the contract's ABI (full control over ergonomics, React-hook-friendliness, and error typing, but must be manually kept in sync with `lib.rs`).

## Questions to answer

- Does the CLI-generated client's shape (method signatures, error types) already meet what epic E12's later issues (typed errors, transaction builders, React hooks) need, or would a hand-written layer be needed on top regardless — in which case, is the generated layer adding value or just an extra dependency?
- How is regeneration triggered and verified against contract drift — is there a CI check that fails if the generated bindings are stale relative to the deployed `VERSION`?

## Expected output

A decision recorded in `packages/sdk-ts/DESIGN.md`, with the chosen approach and, if generated bindings are used, the regeneration workflow; if hand-written, the rationale for not using the generator.

## Acceptance criteria

- [ ] Both options are evaluated against this contract's actual generated output (try it, don't just reason abstractly).
- [ ] A decision is recorded with rationale.
- [ ] If generated bindings are chosen, a CI check (or documented manual process) ensures they don't silently drift from the deployed contract.

## Files

- packages/sdk-ts/DESIGN.md
