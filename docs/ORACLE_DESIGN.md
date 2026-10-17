# Oracle-Backed Task Conditions

**Status:** Reflector-first architecture approved. Band support is deferred
pending maintained, network-specific deployments.

## Scope

Oracle conditions implement the generic E10 `ITaskCondition::is_met(task_id)`
interface. The registry stores only the condition contract address and has no
oracle-specific storage or entry points. Provider calls, normalization,
freshness checks, and predicate evaluation stay inside the condition contract.

Each condition deployment has immutable configuration: provider address,
asset, predicate parameters, and maximum data age. Changing any of those
assumptions requires deploying a new condition and registering a new task.

## Supported providers

| Provider | Decision | Reason |
|---|---|---|
| Reflector Pulse | Supported first | Soroban-native SEP-40 interface with `lastprice`, `decimals`, and observation timestamps. |
| Reflector Beam | Deferred | Its invocation fee needs a separate authorization and fee-budget design before a claimability view can remain side-effect-free. |
| Band Standard Reference | Deferred; see feasibility study below | A Soroban implementation exists, but no maintained source currently publishes verifiable Testnet and Mainnet contract IDs. |
| Arbitrary look-alike feeds | Unsupported by reference deployments | Matching an ABI does not establish data quality or operator trust. |

Reference deployments must pin an oracle contract ID and network together.
The same contract ID must never be assumed to identify a supported provider on
another network.

## Canonical price and freshness rules

Condition logic consumes one internal shape:

```rust
struct NormalizedPrice {
    value: u128,       // positive price at exactly 18 decimal places
    observed_at: u64,  // Unix timestamp
}
```

All prices normalize to `PRICE_SCALE = 10^18`; floating-point values and
rounding are forbidden. For a positive Reflector value `p` with `d` decimals:

```text
require 0 <= d <= 18
normalized = p * 10^(18 - d)
```

The conversion, exponentiation, and multiplication use checked operations.
Zero, negative, over-precision, or overflowing values fail closed. Band rates
are already documented as 18-decimal `u128` values and require no rescaling.

For ledger time `now`, data is fresh exactly when:

```text
observed_at <= now
and
now - observed_at <= max_age_seconds
```

The boundary is inclusive. Missing, stale, future-dated, malformed, zero, or
unreadable data returns `false`; it never reuses a cached observation. The
configured maximum age is immutable and must be in `1..=86_400` seconds.

## Predicate arithmetic

Threshold conditions compare normalized values directly. Deviation conditions
evaluate an absolute move from the immutable reference price without division:

```text
absolute_difference * 10_000 >= reference_price * basis_points
```

Both products use checked 256-bit arithmetic. The reference must be positive
and `basis_points` must be in `0..=10_000`. Capturing the reference once during
condition initialization prevents any later caller from moving the trigger.

## Band Protocol feasibility study

Reviewed on 2026-10-17 against Band's official
[Soroban Standard Reference repository](https://github.com/bandprotocol/band-std-reference-contracts-soroban)
and [Soroban integration announcement](https://blog.bandprotocol.com/bandprotocol-integration-with-stellar-smart-contracts/).

### Deployment finding

Band announced that its oracle service was available on Soroban Mainnet and
Testnet in 2024. The maintained source repository, however, currently provides
only local/Futurenet deployment instructions. It does not publish a current
contract ID, deployment ledger, or code checksum for either Stellar Testnet or
Mainnet, and it has no tagged release that a deployment can be tied to.

Accordingly, Keeper Network has **no verifiable Band contract ID to list for
Testnet and no verifiable Band contract ID to list for Mainnet**. This does not
claim that no historical deployment ever existed; it means no current official
deployment can be pinned and reviewed to the standard required by reference
condition contracts.

### Interface finding

The published ABI is technically adaptable but is not SEP-40:

```text
get_reference_data(Vec<(Symbol, Symbol)>)
    -> Result<Vec<ReferenceData>, Error>

ReferenceData {
    rate: u128,               // 18 decimal places
    last_updated_base: u64,
    last_updated_quote: u64,
}
```

A future adapter would call one base/quote pair, require exactly one result,
require a positive rate, and map it to the shared shape as follows:

```text
value = rate
observed_at = min(last_updated_base, last_updated_quote)
```

Using the older of the two timestamps prevents one freshly updated side from
masking stale data on the other. Provider errors, malformed vector lengths, and
conversion failures all map to a closed `false` condition result.

### Decision and revisit gate

Band support is deferred. It can be revisited only when all of the following
are available from an official Band source:

1. Current Testnet and Mainnet contract IDs, identified separately.
2. Deployment ledgers and WASM/code hashes that make those IDs reproducible.
3. A tagged or otherwise immutable ABI revision with an active maintenance
   statement for Soroban.
4. Test vectors confirming the rate scale and timestamp units on both networks.

When those requirements are met, add a provider-specific Band client rather
than making it impersonate Reflector's SEP-40 client. The adapter must return
the same internal `NormalizedPrice`, pass the shared missing/stale/future-data
tests, and pin the reviewed provider address in deployment documentation.

## Trust boundary

A fresh value may still be economically wrong or manipulable. Freshness only
bounds age. Permissionless task registration also permits owners to attach
custom condition contracts; that does not make their feeds endorsed. Official
deployments label only reviewed and pinned provider addresses as supported.

Feed failure can leave a task pending until the feed recovers or the existing
cancellation/expiry path is used. This denial-of-service tradeoff is accepted
instead of allowing claims when required market data is unknown.
