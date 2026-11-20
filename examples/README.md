# Examples

Runnable examples for the Soroban Keeper Network, and the record of what epic
E22 ("Examples & Ecosystem Integrations") delivered. For how to apply them to
your own protocol, read the [integration guide](../docs/INTEGRATION_GUIDE.md).

## Examples on `main`

| Example | Audience | What it shows |
|---|---|---|
| [`keeper-bot`](keeper-bot) | Keeper operators | A reference keeper in plain Node.js: poll events, decide, claim, execute, withdraw. Includes a dry-run mode ([`EXAMPLES.md`](keeper-bot/EXAMPLES.md)). |
| [`keeper-bot-v2`](keeper-bot-v2) | Keeper operators | A production-oriented TypeScript keeper with prioritisation, profitability checks, multi-account support, metrics and a Docker image. |
| [`batch-register`](batch-register) | Task owners | Registering many tasks from a JSON or CSV file in one `batch_register_tasks` call. Also available as `skn batch register`. |
| [`rust-sdk/examples/liquidation-keeper`](../rust-sdk/examples/liquidation-keeper) | Keeper authors (Rust) | A minimal liquidation keeper. |
| [`rust-sdk/examples/calling-contract`](../rust-sdk/examples/calling-contract) | Protocol developers (Rust) | Calling the registry from your own contract. |
| [`packages/sdk-ts/examples`](../packages/sdk-ts/examples) | dApp developers (TypeScript) | Node signing, wallet signing and a React app. |

## Epic E22 retrospective

Written 2026-11-19 from the state of the repository and the open pull
requests on that date. The epic's work items are the backlog files
`0553` to `0572` under [`.github/backlog/issues`](../.github/backlog/issues).

### Shipped

Merged to `main`: the examples in the table above. Of the E22 items, the
following have a merged deliverable:

| Item | Deliverable | Reason it counts as shipped |
|---|---|---|
| 0568 batch registration recipes | [`batch-register`](batch-register) with JSON and CSV fixtures | The example and its README document both input formats. |
| 0567 Rust calling-contract example | [`rust-sdk/examples/calling-contract`](../rust-sdk/examples/calling-contract) | The example crate exists. A written walkthrough, which 0567 asks for, was not found in the repository. |

### In review, not yet shipped

These have an open pull request. They are listed here, not under "shipped",
because they are not on `main`.

| Items | Pull request |
|---|---|
| 0555 TTL extension, 0556 recurring payment, 0557 token vesting, 0559 limit order | [#924](https://github.com/soroban-tooling/soroban-keeper-network/pull/924) |
| 0558 auction settlement, 0560 dollar-cost averaging, 0565 owner script, 0566 governance execution | [#926](https://github.com/soroban-tooling/soroban-keeper-network/pull/926), [#912](https://github.com/soroban-tooling/soroban-keeper-network/pull/912) |
| 0561 liquidation keeper (TypeScript), 0562 hash-preimage verifier, 0563 condition template, 0564 Next.js starter | [#927](https://github.com/soroban-tooling/soroban-keeper-network/pull/927) |
| 0553 examples index, 0554 local quickstart | [#925](https://github.com/soroban-tooling/soroban-keeper-network/pull/925) |

### Not started

| Item | Why |
|---|---|
| 0569 deploy the examples to testnet and list them ([#808](https://github.com/soroban-tooling/soroban-keeper-network/issues/808)) | Depends on 0555 and 0556, which are not merged. |
| 0570 build and test every example in CI ([#809](https://github.com/soroban-tooling/soroban-keeper-network/issues/809)) | Depends on 0555, which is not merged. Until it lands, CI builds only the packages it already has jobs for. |

### Dropped

No E22 item has been formally dropped, and none is closed as "won't do" in
the tracker. Two scoping decisions are worth recording so nobody mistakes them
for omissions:

- **No reference verifier contracts.** The verifier interface and its
  registry hook exist ([`docs/VERIFIER_DESIGN.md`](../docs/VERIFIER_DESIGN.md)),
  but the reference verifiers from epic E04 (issues 0077 to 0079) were never
  built, as [`docs/VERIFIERS.md`](../docs/VERIFIERS.md) records. The
  hash-preimage verifier in 0562 is therefore the only verifier example, and
  it is still in review. The integration guide tells protocol teams to write
  their own verifier until more exist.
- **Examples live in several places.** Keeper and owner tooling is under
  `examples/`, Rust examples under `rust-sdk/examples/`, and TypeScript SDK
  examples under `packages/sdk-ts/examples/`. They were not consolidated,
  because each is tested with its own package.

### What integrators asked for

No integrator feedback is recorded in the issue tracker or the repository at
the time of writing, so this section does not invent any. The gaps that the
epic's own acceptance criteria and the review above point to, in the order a
protocol team hits them, are:

1. A guide that connects the examples to the decisions a protocol team has to
   make. This is now [`docs/INTEGRATION_GUIDE.md`](../docs/INTEGRATION_GUIDE.md).
2. A one-command local network quickstart (0554, in review).
3. Examples that run in CI, so they cannot rot (0570, not started).
4. Testnet deployments of the examples to try without deploying anything
   (0569, not started).

### Follow-ups

- Merge the in-review pull requests, then update the tables above. Note that
  [#925](https://github.com/soroban-tooling/soroban-keeper-network/pull/925),
  [#926](https://github.com/soroban-tooling/soroban-keeper-network/pull/926)
  and
  [#927](https://github.com/soroban-tooling/soroban-keeper-network/pull/927)
  also edit this file, so they will need their entries merged into it.
- Close 0570 first: it protects every other example.
- Write the 0567 walkthrough for `calling-contract`.
