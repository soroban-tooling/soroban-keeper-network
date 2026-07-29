---
title: "design(registry): feasibility study -- composing multiple verifiers (AND/OR) on one task"
labels: [contract, docs, advanced]
epic: E04
wave: 2
depends_on: [0071]
---

## Summary

The design from issue 0071 attaches exactly one verifier address per task. A more sophisticated dApp might want to require two independent verifications (an oracle attestation AND a signature, for example) before a keeper is paid. This issue studies whether that composition should be a registry-level feature or left entirely to the ecosystem (a dApp author can always deploy their own "composite verifier" contract that itself calls two others and ANDs the results, without the registry needing to know about composition at all).

## Expected behaviour

A recommendation: either the registry stays single-verifier-per-task and composition is explicitly documented as an ecosystem-level pattern (with a worked example of a composite verifier contract, possibly as a fourth reference implementation), or a concrete case is made for first-class multi-verifier support and its own design issue is filed.

## Suggested approach

Lean toward the "keep the registry simple, let composition happen at the verifier-contract level" answer unless there's a concrete reason the registry needs to know about composition directly (for example, if per-verifier gas budgeting from issue 0076 becomes impossible to reason about once verifiers can be nested arbitrarily) -- the permissionless design philosophy elsewhere in this contract favors pushing complexity to the edges.

## Acceptance criteria

- [ ] The single-verifier-plus-composite-contract alternative is seriously considered, not dismissed in favor of a more complex registry feature by default.
- [ ] A recommendation is made with reasoning.
- [ ] If composition-as-a-pattern is the answer, a worked example composite verifier is added as a follow-up (or to issue 0077-0079's scope).

## Files

- docs/VERIFIER_DESIGN.md
