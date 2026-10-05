# Epic E12 retrospective: `@soroban-keeper-network/sdk`

Epic E12 (backlog issues 0151–0194) built `@soroban-keeper-network/sdk`, the
typed TypeScript client for the `keeper-registry` contract that replaces the
hand-rolled `simulate → build → sign → submit → confirm` dance
`examples/keeper-bot` used to open-code. This closes the epic out, in the
same style as wave 2's epic retrospectives (issues 0118, 0141, 0142): what
shipped, what conventions later epics should reuse rather than
reinvent, and — since epic E14 (the event indexer) starts right after this
wave — an explicit answer to the one forward-looking question issue 0264
asked: should E14 depend on this SDK's event decoders, or fork them.

## What shipped

**Client (`src/client.ts`, `src/core/`)** — `KeeperRegistryClient`
implements every `keeper-registry` entry point: the read-only views
(`admin`, `getFeeBps`, `isPaused`, `feesAccrued`, `rewardTokenAddress`,
`minReward`, `getTask`, `taskCount`, `keeperBalance`, `keeperReputation`,
`isClaimable`, `version`, `checkContractCompatibility`), the single-auth
admin calls (`pause`, `unpause`, `setFeeBps`, `setMinReward`), the dual-auth
admin calls (`transferAdmin`, `upgrade`, `sweepFees`), and the task
lifecycle (`registerTask`, `claimTask`, `executeTask`, `cancelTask`,
`expireTask`, `increaseReward`, `extendDeadline`, `withdrawRewards` /
`tryWithdrawRewards`). `ContractInvoker` (`core/contractInvoker.ts`) and
`ContractCaller` (`core/caller.ts`) factor the shared
simulate/build/sign/submit/confirm plumbing into one place, so every typed
method in `src/methods/` is argument conversion and nothing else — the same
split the keeper-bot's own `invokeContract`/`readContract` drew by hand.

**Transaction builders (`src/transactionBuilder.ts`)** — `buildTransaction`,
`buildFeeBumpTransaction`, and `submitSignedTransaction` give a wallet-signing
consumer (one that must never see a private key) the same simulate/assemble
step the signing client uses internally, without the client ever holding a
signer.

**React hooks (`src/react/`)** — `useTask`, `useRegisterTask`,
`useExecuteTask`, `useClaimTask`, `useIsClaimable`, `useKeeperBalance`,
`useTaskEvents`, and the shared `usePolling`/`provider` plumbing, covering
issues #241, #243, #248, and #259.

**Typed errors and event decoding (`src/errors.ts`, `src/events.ts`)** —
`decodeKeeperErrorCode`/`decodeKeeperError` extract a typed
`KeeperErrorCode` from a simulation failure or a failed transaction's
diagnostic events (issue 0166), replacing string-matching with a decoder
keyed on the contract's actual discriminants. `events.ts` (issue 0167)
typed-decodes the five task-lifecycle events `useTaskEvents` needs.

**Retry/backoff (`src/retry.ts`)** — `withRetry`, ported from the
keeper-bot's own exponential-backoff-with-jitter implementation, exported
for external use and (per issue #257) used internally by the client's own
`sendTransaction`/`getTransaction` calls, with a `decodeKeeperErrorCode`-based
classifier standing in for the keeper-bot's message-string matching.

**Testing (`src/testing/fakeRpc.ts`, `src/test-utils/`)** — `FakeRpcServer`
gives an external consumer (or this package's own future tests) a
network-free `RpcServerLike`/`EventSource`-shaped double whose responses
still round-trip through the real `nativeToScVal`/`scValToNative` encoding,
specifically to avoid the assumed-response-shape bug a sibling keeper-bot
test suite hit once (wave-2 PR #128).

**Docs** — `README.md` (usage, workspace-tooling decision),
`CONVENTIONS.md` (issue 0165: `bigint` for `i128`, plain `number` for `u64`
ids/ledgers and every `u32`, `Date | number | bigint` accepted for
timestamps), `VERSIONING.md` (issue 0192: semver-independent SDK versioning
against an explicit `COMPATIBLE_CONTRACT_VERSIONS` table, checked at runtime
via `version()`/`checkContractCompatibility()`), and `DESIGN.md`.

**CI (`.github/workflows/ci.yml`)** — the `sdk-ts` job (required: typecheck,
lint, `vitest run`) gates merges; `sdk-ts-docs` (advisory: TSDoc → API
reference) and the SDK bundle-size report run alongside it, scoped to only
run when `packages/sdk-ts/` changes.

## Conventions later epics should follow, not re-derive

- **Integer representation** (`CONVENTIONS.md`, issue 0165): `i128` as
  `bigint`, `u64`/`u32` as `number`, methods accept the wider
  `bigint | number` / `Date | number | bigint` at the input boundary and
  normalise once, in `core/scval.ts` / `core/time.ts`. A future package
  decoding the same contract's values should use the same split rather than
  picking its own — the contract's numeric shapes do not change per
  consumer.
- **Versioning is independent of the contract's `VERSION`** (`VERSIONING.md`,
  issue 0192): a package's own release cadence and the contract's
  deployment cadence are unrelated events; tie them together with an
  explicit compatibility table, not with semver equality.
- **Typed error decoding over string matching** (issue 0166): a contract's
  `Result::Err` is decodable by numeric discriminant
  (`Error(Contract, #N)` in the simulation/diagnostic text) — this is more
  robust than matching on message text, which is informational and can
  change.
- **One parsing path** for backfill and steady-state (a pattern epic E14
  independently arrived at too, in `indexer/src/backfill.rs`'s
  `Backfiller::run_to_tip`/`run_until_shutdown`): don't let a
  performance-motivated second code path (a "fast" steady-state parser
  next to the "careful" backfill one) exist, because it can drift from the
  one that's actually tested against every historical event shape.

## Should epic E14 depend on this SDK's event decoders, or fork them?

**Neither, in the sense the question was asked — and the epic already
answered it in practice.** `packages/sdk-ts` is TypeScript, published as an
npm package; the event indexer (epic E14, `indexer/`) is a separate Rust
binary crate (`keeper-indexer`) with its own `Cargo.toml` and its own
dependency graph (`tokio-postgres`, `sqlx`, `stellar-xdr`, ...). There is no
mechanism for a Rust crate to import a TypeScript package's functions
directly — "depend on" in the literal, `npm install`/`import` sense this
issue's wording suggests is not on the table for a cross-language boundary,
and by the time this retrospective was written E14 had already, correctly,
built its own decoder (`indexer/src/ingest/parse.rs`'s `parse_event`,
against `indexer/src/events.rs`'s `EventType`/`event.rs`'s `EventPayload`)
rather than waiting on a dependency that could never have existed.

What *did* carry over, and is the real answer to what this issue was
actually getting at — should E14 reuse this epic's decisions or make its
own — is the **conventions**, not the code: `decodeKeeperErrorCode`'s
"decode by discriminant, not by string" approach and the
`bigint`-for-`i128` rule both show up in the indexer's own design
(`indexer/src/numeric.rs` round-trips the full `i128` range explicitly; the
raw-event parser reads the same `(verb, noun)` topic-pair convention this
SDK's `events.ts` documents). **Recommendation for any future same-language
(TypeScript) consumer of this contract's events** — a dashboard, another
SDK, a script — depend on `events.ts`'s exports directly rather than
re-implementing topic decoding; scoping it to the five task-lifecycle
events was already flagged in `events.ts`'s own comment as extendable to
the remaining admin/reward events "the same way without changing this
module's shape," which is exactly the fork-vs-depend question with a clear
answer *for a TypeScript consumer*. For a non-TypeScript consumer like E14,
the honest recommendation is: there was never a decision to make — build
the equivalent decoder in your own language, and follow this epic's
*conventions* (numeric representation, discriminant-based error decoding,
one parsing path) while doing it, which is exactly what E14 did.
