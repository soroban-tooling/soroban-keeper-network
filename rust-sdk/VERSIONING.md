# Rust SDK versioning policy

How this crate's version relates to the keeper-registry contract's `VERSION`
constant, and what the crate does when the two do not line up.

Implements issue 0192's sibling for Rust. **The short version: this crate
follows the same compatibility policy as the TypeScript SDK.** The rest of this
document says what that policy is and why Rust needs no exception.

> **Status: proposed, pending 0192.** The TypeScript SDK's policy
> ([#261](https://github.com/soroban-tooling/soroban-keeper-network/issues/261))
> is still open and unresolved, so there is no settled decision to point at yet.
> This document is written to 0192's own stated shape — a compatibility table
> plus a runtime mismatch check — so the two agree by construction rather than
> by coincidence. **If 0192 lands a different model, this file changes to match
> it rather than the reverse.** See
> [Consistency with the TypeScript SDK](#consistency-with-the-typescript-sdk).

---

## The contract's `VERSION`

`contracts/keeper-registry/src/constants.rs` exposes `VERSION`, currently `3`,
readable on-chain through the `version()` view. Its doc comment states its
purpose exactly: *"bumped on behavior changes so off-chain clients and indexers
can detect which ABI they are talking to."*

Its history to date is entirely **additive**:

| `VERSION` | What changed |
|---|---|
| `1` | MVP lifecycle surface |
| `2` | `calldata` bounded by `MAX_CALLDATA_LEN`; adds the `CalldataTooLarge` error |
| `3` | Batch registration: `batch_register_tasks`, `max_batch_size`, `BatchTaskParams`, and the `BatchTooLarge` / `EmptyBatch` / `BatchRewardCeilingExceeded` errors |

That pattern is what the policy below is calibrated to. It is not a promise the
contract has made, which is why the crate checks rather than assumes.

---

## The policy

### A contract `VERSION` bump requires a **minor** crate bump, not a major one

Adding support for a new contract `VERSION` adds entry points and error
variants to the crate. Under semver that is a minor bump: existing callers
compile and behave identically.

A **major** bump is required only when the crate's own Rust API breaks — a
changed signature, a removed method, a renamed type. That can be *caused* by a
contract change (if the contract ever removes or repurposes an entry point),
but it is not caused by a `VERSION` bump as such. The two are related, not
equivalent, and conflating them would mean shipping a major release for every
additive contract change and exhausting the version space for no reader benefit.

### Compatibility is a table, not a formula

Each release declares the contract `VERSION` values it supports:

| Crate version | Supported contract `VERSION` | Notes |
|---|---|---|
| `0.1.x` | `3` | First release; targets the current contract |

The table is the source of truth and lives in this file and in the crate's
`CHANGELOG.md`. Every release adds a row. A formula ("crate minor = contract
version") looks tidier and breaks the first time the crate ships a release that
adds no contract support at all — a bug fix, a docs pass, a new convenience
method — which is most releases.

### What happens against an unexpected `VERSION`

This is the part the issue asks to be explicit about, so it is stated as three
distinct cases rather than one "mismatch" behaviour:

| Connected contract | Crate behaviour | Why |
|---|---|---|
| **In the supported range** | Proceed silently | Nothing to say |
| **Higher than the maximum supported** | **Warn once, then proceed** | The contract has entry points the crate does not know about, but — given the additive history above — the ones it does know still exist. Refusing would strand every existing deployment the day a new contract ships, over capabilities the caller was not using |
| **Lower than the minimum supported** | **Refuse to construct the client** | The crate will call entry points that do not exist on that contract. Proceeding produces a failure at the call site — an unrecognised-function error, far from the cause — instead of at construction, where the cause is obvious |

The asymmetry is deliberate. Being ahead of the crate is survivable; being
behind it is not, because the crate would be calling functions that are not
there.

**The warning is emitted once per client**, through the `log` facade, not on
every call. A per-call warning on a hot path is noise that gets filtered, and a
filtered warning is not a warning.

**A warning is never an error.** The crate does not fail a call, refuse a
connection, or change behaviour on the strength of a version it does not
recognise — beyond the refusal case above, which is about a call that cannot
work.

### The check is skippable

`KeeperClient::builder().skip_version_check()` exists for the case the policy
cannot anticipate: a fork, a modified contract, a test harness. The check is a
guard rail, and a guard rail with no gate is a wall.

---

## Reading the contract's `VERSION` yourself

The third acceptance criterion, and the one that matters most in practice: a
caller must be able to implement their own check without relying on the crate's
internal one, so the crate's policy never becomes the ceiling on what a
consumer can do.

```rust
// The raw value the deployed contract reports. No interpretation, no
// comparison against the crate's table — just the number.
let version: u32 = client.contract_version().await?;

// What this build of the crate was written against.
let supported: RangeInclusive<u32> = keeper_sdk::SUPPORTED_CONTRACT_VERSIONS;
```

`contract_version()` is a thin wrapper over the contract's own `version()`
view, and both it and `SUPPORTED_CONTRACT_VERSIONS` are public. A consumer with
a stricter policy than this crate's — refusing to proceed on any mismatch, say,
or gating a feature on `VERSION >= 3` — can implement it against these two
values without forking the crate or parsing a log line.

> Lands with the crate itself
> ([#265](https://github.com/soroban-tooling/soroban-keeper-network/issues/265))
> and the typed view wrappers
> ([#335](https://github.com/soroban-tooling/soroban-keeper-network/issues/335)).
> This document is the specification those implement against; the signatures
> above are the contract this file is asserting, not a description of code that
> exists today.

---

## Pinning a known-compatible pair

A consumer who needs a specific contract `VERSION` pins the crate release whose
row names it:

```toml
[dependencies]
# Supports contract VERSION 3 -- see rust-sdk/VERSIONING.md
keeper-registry-sdk = "0.1"
```

Cargo's default caret requirement (`"0.1"` → `>=0.1.0, <0.2.0`) is the right
granularity: patch and minor releases within a line only ever **add** supported
contract versions, never remove one. Dropping support for a contract `VERSION`
is a breaking change and gets a major bump, which the caret will not cross on
its own.

To pin exactly — for a reproducible build, or while auditing:

```toml
keeper-registry-sdk = "=0.1.0"
```

---

## Consistency with the TypeScript SDK

The two SDKs answer the same question about the same contract, so they should
answer it the same way. A developer who reads one policy and applies it to the
other should be right.

This document therefore adopts 0192's stated model — semver-independent SDK
versioning with an explicit compatibility table, plus a runtime mismatch
warning built on the `version()` wrapper — rather than inventing a second one.
As the issue puts it, *"stating 'this Rust SDK follows the same compatibility
policy as the TypeScript SDK' is an acceptable and preferable answer to
inventing a second policy."*

**No Rust-specific exception is claimed.** Two differences in the surrounding
ecosystem are worth naming, because both turn out not to justify one:

- **Cargo's resolver is stricter than npm's.** A Rust consumer gets one version
  of this crate in the dependency graph, where a JS consumer can end up with
  two. That makes the compatibility table *easier* to honour in Rust, not
  different.
- **Rust has no runtime `console.warn`.** The warning goes through the `log`
  facade, so a consumer who initialises no logger sees nothing. That is a
  delivery-mechanism difference, not a policy one — and it is why the crate
  also exposes `contract_version()` publicly rather than treating the log line
  as the only channel.

**Open item for 0192:** whether an out-of-range contract version should warn or
refuse. This document proposes *warn when ahead, refuse when behind*, on the
reasoning above. If 0192 settles on something else, this file adopts it — a
developer hitting the same mismatch in both SDKs should not get two different
behaviours.

---

## Related

- [`contracts/keeper-registry/src/constants.rs`](../contracts/keeper-registry/src/constants.rs) — `VERSION` and its history
- [#261](https://github.com/soroban-tooling/soroban-keeper-network/issues/261) — the TypeScript SDK's policy (0192)
- [#265](https://github.com/soroban-tooling/soroban-keeper-network/issues/265) — scaffolding this crate
- [#335](https://github.com/soroban-tooling/soroban-keeper-network/issues/335) — typed wrappers for the read-only views, including `version()`
