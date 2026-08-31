# SDK-wide conventions

Pinned once, here, so every method in this epic follows the same rule
instead of each one deciding independently. See backlog 0165.

## Large integers (`i128` rewards/balances, `u64` task ids/deadlines)

- **`i128` values** (`reward`, `keeperBalance`, fee accounting) use `bigint`
  end-to-end. `@stellar/stellar-sdk`'s own `scValToNative`/`nativeToScVal`
  already produce/accept `bigint` for `i128`/`i256` — confirmed against the
  installed `^16.2.0` (`scValToNative` on an `i128` `ScVal` returns a
  `bigint`), so this matches the underlying dependency rather than adding an
  unnecessary conversion layer.
- **`u64` task ids and ledger sequences** (`taskId`, `deadline`,
  `claimLedger`) stay plain `number`. A `u64` in this contract's domain
  (task counter, Unix-seconds deadline, ledger sequence) is astronomically
  far from `Number.MAX_SAFE_INTEGER` (2^53), and `number` is far more
  ergonomic than `bigint` for the array indexing, comparisons, and `Date`
  conversion every call site in this epic actually does with them.

## Timestamps

`deadline` (and any other Unix-seconds field) is a plain `number` of
seconds at this SDK's public boundary — not a `Date`. Rationale: the two
obvious consumer types this epic targets are a Node/keeper-bot script doing
arithmetic directly against `Math.floor(Date.now() / 1000)` (the existing
`examples/keeper-bot` pattern) and a React hook comparing against
`Date.now()` — both are one line of conversion away from a `Date` if they
want one (`new Date(deadline * 1000)`), and forcing every internal
comparison through `Date` arithmetic would be strictly more code for no
ergonomic gain given the contract itself only ever deals in seconds.

## Struct field naming

The contract's `#[contracttype]` structs (`Task`, etc.) map to raw
`scValToNative` output with **snake_case field names preserved verbatim**
(confirmed against a real call site — `examples/keeper-bot/index.js`'s
`fullTask.task_type`). This SDK's public types use camelCase
(`taskType`, `claimLedger`, ...); each method (e.g. `methods/views.ts`'s
`getTask`) is responsible for remapping raw → typed at the boundary, so no
snake_case ever leaks past this SDK's own internals.
