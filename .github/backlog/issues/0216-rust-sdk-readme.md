---
title: "docs(rust-sdk): write the crate-level README"
labels: [rust-sdk, docs, good-first-issue]
epic: E13
wave: 3
depends_on: [0199, 0205, 0206, 0207]
---

## Summary

Closes out the core client work in this epic with the entry-point documentation a new integrator actually reads first: what the crate is for, how it differs from the TypeScript SDK in intended use case (native applications and contract-to-contract calls rather than a browser or Node.js dApp), and a minimal working example.

## Expected behaviour

A README following the shape the TypeScript SDK's own README establishes (issue 0182 or wherever that landed), adapted for a Rust audience: installation via Cargo, a short code sample constructing a client and calling register_task, and links out to the fuller docs (rustdoc, the worked example from issue 0214) rather than duplicating them.

## Acceptance criteria

- [ ] A new reader can go from zero to a successful register_task call using only this document and rustdoc.
- [ ] Explicitly states the crate's intended use cases (native apps, contract-to-contract calls) and points TypeScript/browser/Node.js integrators at the other SDK instead.
- [ ] Links to docs/BATCH_OPERATIONS.md and the README event table rather than restating their contents.

## Files

- rust-sdk/README.md
