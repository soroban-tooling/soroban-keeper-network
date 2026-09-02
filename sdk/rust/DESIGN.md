# Rust SDK design: sync vs. async, and the error strategy

Settles two design questions from early in this crate's life (issues #266
and #269), written up before this crate grew contract method wrappers.
Both decisions are grounded in this crate's likely consumers rather than an
abstract preference, per #266's acceptance criteria.

> **Naming note:** this document originally proposed the error type below
> under the name `SdkError`. By the time this work landed, issue #268's
> `methods.rs` had already introduced its own `SdkError` (wrapping
> [`ClientError`](src/client.rs)) — see that type's own doc comment. To
> avoid a collision, the type below ships as [`KeeperSdkError`]
> (`src/keeper_error.rs`) instead. The reasoning and shape are otherwise
> unchanged from what's written here.

## Likely consumers

- **Native services** (e.g. a backend that indexes `keeper-registry` state
  or submits transactions on a schedule) — already running inside an async
  runtime (most commonly `tokio`, since that's what `reqwest` — and
  therefore `soroban-client`, see below — pulls in transitively) for
  unrelated I/O (HTTP servers, database pools, other RPC clients).
- **Other Soroban contracts' off-chain tooling** — CLIs, deploy/ops scripts,
  test harnesses — typically short-lived processes that make a handful of
  RPC calls and exit.
- **A possible future Rust-based keeper bot** (per a future epic, if one
  gets built alongside the existing JS keeper bot in `examples/keeper-bot`)
  — a long-running polling loop, again naturally async since it needs to
  wait on RPC responses without blocking other work (e.g. concurrent task
  claims).

## Async vs. sync

**Decision: async.**

- `soroban-client` (this crate's RPC dependency, pinned in `sdk/rust/Cargo.toml`
  since the scaffold) is itself built on `reqwest`'s async client and exposes
  an `async fn`-based API throughout (`send_transaction`, `get_transaction`,
  `simulate_transaction`, etc.). A sync wrapper here would mean either
  blocking on `reqwest`'s async calls with something like
  `futures::executor::block_on` (works, but silently pulls in a second
  runtime story if the caller is already inside `tokio`, and panics if
  called from within an existing async context without care) or maintaining
  a parallel blocking HTTP client — neither is free, and both add
  maintenance surface this crate doesn't need.
- Every consumer identified above already tolerates or prefers async: native
  services are already async for other I/O; short-lived CLI/ops tooling can
  trivially wrap a `main` in `#[tokio::main]`; a future keeper bot is
  inherently a polling loop, which async expresses more naturally than a
  thread-per-poll sync design.
- The TypeScript SDK is async by necessity (`Promise`-based, no sync I/O
  story in JS at all) — an async Rust SDK keeps the two SDKs' calling
  convention conceptually aligned, even though the concrete mechanism
  differs (`async`/`.await` vs. `Promise`/`await`).

This crate does not pick a specific async runtime itself (no `#[tokio::main]`
anywhere in library code) — it exposes plain `async fn`s and lets the
caller's own runtime (`tokio`, in practice, since that's what `reqwest`
requires) drive them, same as any other async library crate. (`methods.rs`'s
task-lifecycle methods, landed later under #268, follow this same rule.)

## Error strategy

**Decision: `KeeperSdkError`, a superset enum composing `KeeperError`
(reused directly) with this crate's own RPC/network/decode failure modes.**

```rust
pub enum KeeperSdkError {
    Contract(keeper_registry::KeeperError),
    Network(soroban_client::error::Error),
    Decode(String),
}
```

- **`Contract(KeeperError)`** — the contract rejected the call. `KeeperError`
  is already a public type in the `keeper-registry` workspace member (a
  `#[contracterror]` enum, see `contracts/keeper-registry/src/errors.rs`),
  so this variant reuses it directly rather than redefining or renumbering
  the same set of failure reasons — per the type-reuse principle from #0198.
  These are the "actionable, often expected" failures: `TaskNotFound`,
  `Unauthorized`, `DeadlinePassed`, and so on — a caller can usually match on
  the exact variant and decide what to do (retry with different arguments,
  surface a specific user-facing message, etc.).
- **`Network(soroban_client::error::Error)`** — something went wrong
  reaching or talking to the RPC endpoint, wrapping `soroban-client`'s own
  error type verbatim (it already derives `thiserror::Error`, so it carries
  a `Display` impl and composes cleanly via `#[from]`). These are the
  "usually means retry" failures: connection failures, timeouts, malformed
  JSON-RPC responses the client itself couldn't parse.
- **`Decode(String)`** — a response the RPC client didn't itself fail on,
  but this SDK couldn't interpret (e.g. an XDR payload that doesn't match
  the shape a client method expects). Distinct from `Network` because the
  RPC round-trip succeeded; distinct from `Contract` because the contract
  never actually ran or returned this — the failure is in this crate's own
  decoding step.

### Why a composing enum instead of reusing `KeeperError` directly everywhere

`KeeperError` alone cannot represent "the RPC call itself failed" or "the
response was undecodable" — those aren't contract-level failure reasons, and
forcing them into `KeeperError`'s variant set would mean either inventing
contract error codes for conditions the contract never actually detects (an
ABI concern, since discriminants are the published wire format — see the
warning at the top of `errors.rs`), or having every SDK method return two
unrelated error types depending on where the failure happened. A superset
enum is the standard shape for exactly this situation.

### Relationship to `methods::SdkError`

`methods.rs` (issue #268) independently introduced its own `SdkError`,
composing [`ClientError`](src/client.rs) with an `InvalidArgument` case for
argument-encoding failures ahead of the RPC call. Both types solve the same
general problem — give every fallible method in this crate one consistent
`Result<T, E>` — but at different layers and with different provenance:
`methods::SdkError` wraps the generic `invoke`/`read` client's own error
type, while `KeeperSdkError` wraps the contract's error type directly. This
document does not attempt to unify them into one type; see
`src/keeper_error.rs`'s module doc comment for the fuller comparison.

### Ergonomics, confirmed in code (not just in theory)

- `From<KeeperError> for KeeperSdkError` and `From<soroban_client::error::Error>
  for KeeperSdkError` make `?`-based propagation work throughout the rest of
  the crate — a method that gets back a `Result<T, KeeperError>` from
  decoding a simulated invocation's error, or a
  `Result<T, soroban_client::error::Error>` from an RPC call, can propagate
  either with a bare `?`.
- `KeeperError`'s variants are reachable through `KeeperSdkError` via
  `KeeperSdkError::Contract(keeper_registry::KeeperError::TaskNotFound)` — a
  caller matching on `KeeperSdkError` sees the exact contract variant, not
  an opaque wrapper, without needing to know anything about this crate's
  internal wrapping beyond matching one enum layer.
- `KeeperError` itself has no `Display`/`std::error::Error` impl (it's a
  `#[contracterror]` enum — no-std-friendly, u32-discriminant based, no
  message text by design, since contract errors decode by number on the
  wire). `KeeperSdkError` provides its own `Display` (mapping each
  `KeeperError` variant to a short human-readable description) and
  implements `std::error::Error`, so this crate's error type is usable
  anywhere a native Rust error is expected (`anyhow`, `?` in a `fn main() ->
  Result<(), Box<dyn std::error::Error>>`, etc.) without the caller needing
  to bridge that gap themselves.
- See `sdk/rust/src/keeper_error.rs` for the implementation and that file's
  unit tests for confirmation this compiles and round-trips through `?` as
  described.

## Consistency with the TypeScript SDK (#0166)

The TypeScript SDK's error decoder (#0166) draws the same actionable-vs-transient
line this design does, using its own concrete types (a decoded contract error
vs. a network/RPC-layer error). The two SDKs will never share a concrete
error type across languages, but a caller moving between them should find
the same two-way split — "the contract said no" vs. "something went wrong
reaching the network" — in both.
