# SDK-wide conventions

Pinned once, here, so every method in this epic follows the same rule
instead of each one deciding independently. See backlog 0165. Method issues
should link here rather than re-litigating any of these decisions.

## Large integers (`i128` rewards/balances, `u64` task ids/deadlines)

- **`i128` values** (`reward`, `keeperBalance`, `minReward`, `feesAccrued`,
  fee accounting) use `bigint` end-to-end. `@stellar/stellar-sdk`'s own
  `scValToNative`/`nativeToScVal` already produce/accept `bigint` for
  `i128`/`i256` — confirmed against the installed `^16.2.0` (`scValToNative`
  on an `i128` `ScVal` returns a `bigint`), so this matches the underlying
  dependency rather than adding an unnecessary conversion layer. Returning
  `number` instead would mean narrowing a `bigint` ourselves — lossy above
  2^53 — only to re-widen it when the caller passes the value back into a
  write call.
- **`u64` task ids and ledger sequences** (`taskId`, `deadline`,
  `claimLedger`) stay plain `number` **at the output boundary**. A `u64` in
  this contract's domain (task counter, Unix-seconds deadline, ledger
  sequence) is astronomically far from `Number.MAX_SAFE_INTEGER` (2^53), and
  `number` is far more ergonomic than `bigint` for the array indexing,
  comparisons, and `Date` conversion every call site in this epic actually
  does with them.
- **`u32` values** (`feeBps`, `ttlLedgers`, `lockLedgers`) stay plain
  `number`: `scValToNative` already returns `number` for `u32`, and `u32`'s
  range never approaches the safe-integer boundary.

### Method input boundary

Methods accept `bigint | number` for `i128`/`u64` parameters — see
`IntegerInput` and `toBigInt` in `src/core/scval.ts` — and normalise to
`bigint` before encoding. Task ids in particular are awkward as `bigint`
literals in a `for` loop or an array index, so requiring one would cost
ergonomics for no safety.

A `number` argument that is non-integer, or outside `Number.isSafeInteger`
range, throws synchronously before any network call. Silently truncating a
caller's reward, balance, or task id would be far worse than making them
pass a `bigint` literal: a value that has already lost precision in
JavaScript would address the wrong task or move the wrong amount.

## Timestamps

`deadline` and `newDeadline` are Unix-second `u64` values on-chain, and the
two consumer shapes this SDK targets disagree on what is ergonomic:
application code holds a `Date`, while a keeper bot already computes
`Math.floor(Date.now() / 1000)` (see
[`examples/keeper-bot/index.js`](../../examples/keeper-bot/index.js)) and
would otherwise wrap that back into a `Date` only for the SDK to unwrap it
again.

**Input:** methods accept `Date | number | bigint` (`TimestampInput` in
`src/core/time.ts`) and normalise through `toUnixSeconds`:

- `Date` — converted via `Math.floor(date.getTime() / 1000)`, truncating
  rather than rounding so a deadline never lands earlier than the instant
  the caller named
- `number` / `bigint` — read as Unix **seconds**, never milliseconds

Accepting all three is not indecision. The ambiguity that would make it
dangerous — seconds versus milliseconds — cannot arise: a `Date` is
unambiguous, and a bare number is documented, checked, and only ever read as
seconds. A value past the year 10,000 in Unix seconds is rejected at the
boundary as the unit mistake it almost certainly is.

**Output:** a timestamp read back out of a view (`getTask().deadline`) is a
plain `number` of seconds, per the `u64` rule above — not a `Date`. Both
consumer shapes are one line away from a `Date` if they want one
(`new Date(deadline * 1000)`), and forcing every internal comparison through
`Date` arithmetic would be strictly more code for no ergonomic gain given
the contract itself only ever deals in seconds. `fromUnixSeconds` in
`src/core/time.ts` is available for call sites that do want a `Date`.

## Struct field naming

The contract's `#[contracttype]` structs (`Task`, etc.) map to raw
`scValToNative` output with **snake_case field names preserved verbatim**
(confirmed against a real call site — `examples/keeper-bot/index.js`'s
`fullTask.task_type`). This SDK's public types use camelCase
(`taskType`, `claimLedger`, ...); each method (e.g. `methods/views.ts`'s
`getTask`) is responsible for remapping raw → typed at the boundary, so no
snake_case ever leaks past this SDK's own internals.

## Applying this to the drafted method issues

Issues 0154 (admin single-auth methods, `setMinReward`'s `i128` and
`setFeeBps`'s bound check), 0155 (dual-auth admin methods, `sweepFees`'s
`i128` amount), 0160 (read-only views, `Task.reward` / `Task.deadline`), and
0163 all follow the decisions above: `bigint` for every `i128` value,
`number` for `u64` ids/ledgers/timestamps and every `u32`, `bigint | number`
accepted at the input boundary, and `Date | number | bigint` accepted for
every timestamp parameter.
