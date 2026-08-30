# @soroban-keeper-network/sdk

Typed TypeScript client for the Soroban Keeper Network `keeper-registry`
contract. This package is currently a **scaffold** (backlog 0151 / epic
E12): it ships build tooling, a `tsconfig.json`, and a placeholder export
so the ESM/CJS/`.d.ts` pipeline is proven end to end. The
`KeeperRegistryClient` and its per-entry-point methods land in the rest of
epic E12's issues.

## Workspace tooling decision

This package is a **standalone npm package**, not an npm/pnpm workspace
member — there is no root `package.json` in this repository. This matches
the existing convention for `examples/keeper-bot` and
`examples/batch-register`, which are each installed and built independently
with their own `node_modules`. Adopting workspaces would be a repo-wide
change affecting those packages too, which is out of scope for this
scaffold; it can be revisited later if the growing number of `packages/`
and `examples/` entries makes standalone installs unwieldy.

## Quick start

```bash
cd packages/sdk-ts
npm install
npm run build   # emits dist/cjs (CommonJS), dist/esm (ESM), and .d.ts declarations
npm test        # builds, then runs the require()/import smoke tests
```

## API reference

Generated from this package's TSDoc comments via
[TypeDoc](https://typedoc.org/) (config: `typedoc.json`), so every exported
method, hook, and type contributes to the reference automatically by having
a good doc comment — no separate documentation PR needed per method.

```bash
npm run docs        # generates HTML into docs/reference/ (gitignored — a build artifact, not source)
npm run docs:check  # generates with warnings treated as errors; fails if any exported symbol is undocumented
```

`docs:check` is wired into CI (`.github/workflows/ci.yml`'s `sdk-ts-docs`
job) as an **advisory** check — it reports doc-comment regressions in the
job summary but never blocks a PR, consistent with this repo's advisory-vs-required
CI policy (see `docs/CI.md`).

**Output and publishing:** HTML, generated on demand and gitignored — not
committed to this repo, and not yet published anywhere (e.g. GitHub Pages).
Publishing the generated output is explicitly out of scope for now; this
can be revisited once the SDK's surface is large enough to be worth
browsing outside of a local `npm run docs`.

## Layout

- `src/index.ts` — package entry point.
- `tsconfig.json` — shared compiler options.
- `tsconfig.cjs.json` / `tsconfig.esm.json` — per-target build configs.
- `typedoc.json` — TypeDoc config for the generated API reference.
- `test/` — `node --test` smoke tests, one exercising `require()` and one
  exercising `import`, against the built `dist/` output.
