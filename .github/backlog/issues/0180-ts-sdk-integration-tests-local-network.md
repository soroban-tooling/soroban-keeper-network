---
title: "test(sdk-ts): integration test suite against a local Soroban network"
labels: [testing, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Every method issue in this epic (0154-0169) asks for tests, but a truly convincing test exercises the full simulate-sign-submit path against a real (if local) network, not a mocked RPC — mocks can drift from actual Soroban RPC behavior in ways that only a real network catches.

## Expected behaviour

A test setup using the Soroban local network (via `stellar container` / the standard local quickstart image, or whatever the project's `docs/DEPLOYING.md` already recommends for local testing) that deploys a fresh `keeper-registry` instance, initializes it, and runs every SDK method against it end to end at least once, as a CI-gated (or explicitly opt-in, if local-network startup is too slow/flaky for every PR) suite.

## Acceptance criteria

- [ ] At minimum, the full task lifecycle (register, claim, execute, withdraw) and the full admin lifecycle (pause, fee change, transfer) are each exercised against a real local network instance.
- [ ] CI wiring decision (every PR vs. nightly vs. manual) is made explicitly with reasoning, mirroring the fast-vs-thorough tradeoff issue 0146 already worked through for fuzzing.
- [ ] Documented in the SDK's own CONTRIBUTING section how to run this suite locally.

## Files

- packages/sdk-ts/src/integration.test.ts
- .github/workflows/ci.yml
