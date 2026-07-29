---
title: "feat(sdk-ts): scaffold the TypeScript SDK package"
labels: [tooling, enhancement, intermediate]
epic: E12
wave: 3
depends_on: []
---

## Summary

Opens epic E12. Nothing in this repository currently packages a typed client for the keeper-registry contract -- the keeper-bot example calls `@stellar/stellar-sdk` directly and hand-builds every operation. This issue scaffolds a new `packages/sdk-ts/` (or `sdk/typescript/`, pick one convention and use it consistently across the epic) workspace package: build tooling, TypeScript config, and a placeholder export, with no contract-specific logic yet.

## Expected behaviour

- A new package with its own `package.json` (name scoped under the project, e.g. `@soroban-keeper-network/sdk`), `tsconfig.json`, and a build script producing both ESM and CJS output plus `.d.ts` declarations, since consumers may be Node scripts (CJS, like the existing keeper-bot example) or bundler-based frontends (ESM).
- Depends on `@stellar/stellar-sdk` as its only runtime dependency at this stage.
- A trivial exported constant or version string, just enough to prove the build pipeline works end to end.
- Wired into the root workspace (if this repo adopts npm/pnpm workspaces for this — decide and document which, consistent with how `examples/keeper-bot` is currently a standalone package with its own `node_modules`).

## Acceptance criteria

- [ ] `npm run build` (or workspace equivalent) produces ESM, CJS, and type declarations.
- [ ] A minimal smoke test imports the package and confirms it loads under both `require` and `import`.
- [ ] CI gets a new job building this package, consistent with how the existing `bot` job in `ci.yml` builds `examples/keeper-bot`.
- [ ] Decision on workspace tooling (npm workspaces, pnpm, or fully standalone like the bot example) is made explicitly and documented, not defaulted to silently.

## Files

- packages/sdk-ts/package.json
- packages/sdk-ts/tsconfig.json
- packages/sdk-ts/src/index.ts
- .github/workflows/ci.yml
