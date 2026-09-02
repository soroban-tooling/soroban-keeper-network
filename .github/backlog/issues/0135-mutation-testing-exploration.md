---
title: "research: evaluate mutation testing for the keeper-registry test suite"
labels: [testing, docs, advanced]
epic: E03
wave: 2
depends_on: []
---

## Summary

Coverage percentage (issue 0030's cargo-llvm-cov work) tells you which lines ran during the test suite, not whether the assertions would actually catch a bug in those lines. Mutation testing -- deliberately introducing small bugs (flipping a comparison operator, changing a constant) and checking whether the test suite fails -- answers the question coverage cannot. This issue is an evaluation, not a commitment: is a mutation-testing tool practical for a #![no_std] Soroban contract crate, and if so, is running it worth the (typically very high) CI time cost.

## Expected behaviour

Try running an available Rust mutation-testing tool (survey what exists and actually works with a #![no_std] SDK-dependent crate -- this is not guaranteed to be straightforward) against contracts/keeper-registry, and report: does it run at all, how long does a full mutation run take, and what does it find -- ideally at least one surviving mutant (a bug the test suite fails to catch) that's worth turning into a new test case as a concrete demonstration of value.

## Acceptance criteria

- [ ] A specific tool is actually tried, not just discussed abstractly.
- [ ] Practical feasibility (does it run, how long does it take) is reported honestly, including if the answer is "not practical for this crate today."
- [ ] If it finds a real surviving mutant, that gap is fixed with a new test in the same PR or a fast follow-up, as concrete proof of the technique's value.
- [ ] A recommendation: adopt as a periodic (not per-PR, given likely runtime) CI job, or don't -- with reasoning either way.

## Files

- docs/CI.md
