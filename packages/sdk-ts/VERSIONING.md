# SDK versioning policy

This document is the policy several epic issues (0154, 0157, 0163, 0166)
assume exists: how a `@soroban-keeper-network/sdk` release maps to the
`KeeperRegistry` contract's `VERSION` (see
`contracts/keeper-registry/src/constants.rs`), and what to do when they
drift.

## The model

**Semver-independent SDK versioning**, with an explicit compatibility table
mapping SDK version ranges to the contract `VERSION` values they were built
and tested against.

Why not tie the SDK's own semver directly to the contract's `VERSION`
instead (e.g. SDK `3.x` ⇔ contract `VERSION 3`)? Because they change for
different reasons on different schedules:

- The contract's `VERSION` only changes when the contract's on-chain
  behavior or storage shape changes — a rare, deliberate event, gated by the
  same process as any other contract upgrade.
- The SDK's version changes for reasons that have nothing to do with the
  contract at all: a bug fix in `withRetry`'s jitter calculation, a new
  `NetworkPreset`, a TypeScript type improvement, a dependency bump. Forcing
  every one of those into contract-version lockstep would mean either an SDK
  release cadence artificially throttled to contract releases, or a semver
  number that lies about what actually changed.

So the two version numbers are independent, and the compatibility table is
the thing that ties them together explicitly, rather than by convention.

## The compatibility table

Source of truth: `COMPATIBLE_CONTRACT_VERSIONS` in
[`src/version.ts`](./src/version.ts) — kept as code, not only prose, so the
runtime check below has something precise to check against.

| SDK version range | Compatible contract `VERSION` | Notes |
|--------------------|-------------------------------|-------|
| `0.1.x`             | `3`                            | Initial release. |

Each row is added when an SDK release changes which contract `VERSION`
values it's known to work with — either because the contract shipped a new
`VERSION` the SDK has been updated to understand, or because a contract
`VERSION` the SDK previously supported is deliberately dropped (e.g. a
storage-shape change the SDK can no longer decode).

**A single SDK release can support more than one contract `VERSION`** when
the difference between those versions doesn't affect anything the SDK reads
or writes (e.g. a contract change that only touches an admin-only function
the SDK doesn't wrap). The table making that explicit is exactly the value
over "the SDK targets whatever's on mainnet right now."

## The runtime check

`KeeperRegistryClient.version()` (see [`src/client.ts`](./src/client.ts))
reads the deployed contract's `VERSION` via its `version()` view function,
returning `undefined` if the read fails for any reason (RPC error, or an
older deployment predating the `version()` view entirely).

`checkContractCompatibility(contractVersion)` and `compatibilityWarning(result)`
(see [`src/version.ts`](./src/version.ts)) compare that value against
`COMPATIBLE_CONTRACT_VERSIONS` and produce a human-readable warning when
they don't match — including the case where the contract's version could
not be determined at all, which is reported as incompatible rather than
silently assumed fine.

**The SDK does not itself throw or refuse to operate on an incompatible
contract.** It reports the mismatch; the calling application decides
whether that's a hard stop (e.g. a keeper bot refusing to run against an
unrecognized contract) or a logged warning it proceeds past (e.g. a
read-only dashboard). Example:

```ts
import { KeeperRegistryClient, checkContractCompatibility, compatibilityWarning } from "@soroban-keeper-network/sdk";

const client = new KeeperRegistryClient({ contractId, network: "testnet", keypair });
const contractVersion = await client.version();
const compatibility = checkContractCompatibility(contractVersion);
const warning = compatibilityWarning(compatibility);
if (warning) {
  console.warn(warning);
  // or: throw new Error(warning), depending on how strict the caller wants to be
}
```

## Release checklist

When cutting a new SDK release:

1. Bump `version` in `package.json` **and** `SDK_VERSION` in `src/version.ts`
   (kept in sync by hand for now — see that file's own comment on why).
2. If the release changes which contract `VERSION`(s) it supports, update
   `COMPATIBLE_CONTRACT_VERSIONS` in `src/version.ts` **and** add a row to
   the table above.
3. Add an entry to [`CHANGELOG.md`](./CHANGELOG.md) documenting: what
   changed, and — if it changed — which contract `VERSION`(s) this release
   targets.
