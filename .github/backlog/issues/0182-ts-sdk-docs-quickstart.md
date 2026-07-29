---
title: "docs(sdk-ts): quickstart README"
labels: [docs, good-first-issue]
epic: E12
wave: 3
depends_on: [0154, 0163]
---

## Summary

The package's own README, covering installation and the smallest possible working example, following the pattern `examples/keeper-bot`'s header comment already sets for this repository (usage snippet up front, design notes after).

## Expected behaviour

Install instructions, a minimal "register a task and read it back" example against testnet, and a one-paragraph orientation to the rest of the SDK's surface (client methods, transaction builders for wallet flows, React hooks) with links to their respective deeper docs.

## Acceptance criteria

- [ ] The quickstart example actually runs as written against a real testnet deployment — copy-paste it and confirm, don't just eyeball it.
- [ ] Links out to `CONVENTIONS.md` (issue 0165), the error-handling doc, and the React hooks guide (issue 0185) rather than duplicating their content.

## Files

- packages/sdk-ts/README.md
