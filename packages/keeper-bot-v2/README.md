# Keeper Bot v2

Keeper Bot v2 is the operator-focused keeper service for the Soroban Keeper
Network. It is a separate TypeScript package so production concerns such as
durable state, bounded concurrency, profitability policy, executor plugins,
and observability can evolve without making the introductory bot harder to
read.

If you are new to the project or want a compact walkthrough of the keeper
lifecycle, start with [`examples/keeper-bot`](../../examples/keeper-bot/).
That CommonJS example remains the learning-oriented implementation. This
package targets operators who need explicit failure handling and operational
controls.

## Requirements

- Node.js 24 LTS
- npm 11 or newer

## Development

```sh
npm install
npm run build
npm test
npm run lint
```

The initial package intentionally contains no keeper loop. Runtime features are
added as independently tested modules while the package foundation stays
strict, buildable, and linted from its first revision.

## Profitability settings

All amounts are integer stroops. V2 validates these settings before evaluating
or claiming any task:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `KEEPER_MIN_PROFIT_STROOPS` | `0` | Minimum net profit required before claiming. |
| `KEEPER_EXECUTE_FEE_FALLBACK_STROOPS` | `1000000` | Conservative execute cost when it cannot be simulated before claim. |
| `KEEPER_WITHDRAWAL_FEE_STROOPS` | `100000` | Estimated fee for one reward withdrawal. |
| `KEEPER_WITHDRAWAL_BATCH_SIZE` | `10` | Tasks over which the withdrawal fee is amortized. |
| `KEEPER_PROFIT_RISK_BUFFER_STROOPS` | `100000` | Extra cost buffer applied to every decision. |
| `KEEPER_MAX_ESTIMATE_AGE_MS` | `30000` | Maximum age of a cost estimate; stale estimates fail closed. |
