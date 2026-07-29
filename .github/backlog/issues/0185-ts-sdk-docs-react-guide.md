---
title: "docs(sdk-ts-react): hooks usage guide with a worked example app"
labels: [docs, good-first-issue]
epic: E12
wave: 3
depends_on: [0173, 0174, 0175, 0179]
---

## Summary

The React hooks (issues 0173-0179) are individually documented via their own doc comments (feeding issue 0183's generated reference), but a newcomer benefits more from one worked example showing several hooks composed together in a realistic small app than from a list of isolated API entries.

## Expected behaviour

A minimal example app (a task list showing live registrations via `useTaskEvents`, a register-task form via `useRegisterTask`, and a keeper balance widget via `useKeeperBalance`/`useWithdrawRewards`) as either a runnable example directory or a heavily-commented single-file walkthrough in the docs.

## Acceptance criteria

- [ ] The example actually runs (against testnet or the local network from issue 0180) and is not just illustrative pseudocode.
- [ ] Demonstrates the `KeeperRegistryProvider` setup from issue 0173 as the starting point, so a reader sees the full picture from app root down to individual hook usage.

## Files

- packages/sdk-ts/examples/react-app/
- packages/sdk-ts/docs/REACT_GUIDE.md
