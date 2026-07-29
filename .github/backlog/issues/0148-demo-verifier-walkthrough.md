---
title: "docs(demo): add a verifier-gated task walkthrough to DEMO.md"
labels: [docs, good-first-issue]
epic: E04
wave: 2
depends_on: [0074, 0077]
---

## Summary

DEMO.md presumably walks a reader through registering, claiming, and executing a basic task end to end. Once the verifier feature and its signature-based reference implementation (issue 0077) exist, the demo should show the richer flow too, since "attach a verifier" is exactly the kind of feature a reader skimming a demo would otherwise miss entirely.

## Expected behaviour

An additional section in DEMO.md walking through: deploying the signature-verifier reference contract, registering a task with it attached, generating a valid signed proof, and executing successfully -- plus, briefly, what happens if you try to execute with an invalid signature, to show the rejection path too.

## Acceptance criteria

- [ ] Walkthrough is copy-pasteable against a real testnet deployment, consistent with the rest of DEMO.md's style.
- [ ] Shows both the success and rejection paths.
- [ ] Links to docs/VERIFIERS.md for readers who want the full integration reference rather than just the demo.

## Files

- DEMO.md
