---
title: "chore(ci): track SDK bundle size against a budget, mirroring the contract's wasm-size job"
labels: [tooling, good-first-issue]
epic: E12
wave: 3
depends_on: [0151, 0106]
---

## Summary

A browser-consumed SDK (per the React hooks and wallet-signing work in this epic) has a real bundle-size cost for end users, the frontend analogue of the contract's own WASM-size concern. This issue applies the same pattern issue 0106 built for the contract's WASM size -- an advisory CI job reporting size and delta against a committed baseline -- to the SDK's built output.

## Expected behaviour

A CI job building the SDK's ESM output and reporting its (and its React subpath's) minified/gzipped size, with a baseline file and delta reporting following the same convention as issue 0106.

## Acceptance criteria

- [ ] Reports size for both the core client and the React subpath separately, since a non-React consumer should be able to see that they are not paying for React-hook code they never import.
- [ ] Follows the same baseline-and-delta pattern as the contract's wasm-size job for consistency.

## Files

- .github/workflows/ci.yml
- packages/sdk-ts/bundle-size-baseline.json
