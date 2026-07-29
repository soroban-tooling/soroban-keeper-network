---
title: "chore(ci): extend Dependabot to cover the fuzz/ crate's Cargo.toml"
labels: [tooling, good-first-issue]
epic: E03
wave: 2
depends_on: [0051]
---

## Summary

Wave 1's Dependabot config watches the root Cargo.toml (the main workspace) and examples/keeper-bot's package.json. The fuzz/ crate from issue 0051 is deliberately excluded from the main workspace (to keep libfuzzer-sys out of normal builds), which means its own Cargo.toml is invisible to the existing Dependabot configuration and would never get automated dependency updates.

## Expected behaviour

Add a second cargo-ecosystem entry to .github/dependabot.yml pointing at the fuzz/ directory specifically, following the same grouping and scheduling conventions the existing entries use.

## Acceptance criteria

- [ ] fuzz/Cargo.toml's dependencies (libfuzzer-sys, arbitrary, and the path dependency on keeper-registry itself) are covered by Dependabot.
- [ ] Follows the same patch/minor grouping, major-version-separate-PR convention as the existing cargo entry.

## Files

- .github/dependabot.yml
