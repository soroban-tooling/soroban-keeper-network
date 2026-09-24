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

## Metrics

`KeeperMetrics` publishes Prometheus text at `/metrics` through a dedicated HTTP
server. The default bind is `127.0.0.1:9464`. The scrape handler only reads the
in-memory registry; it does not call RPC or wait for the keeper loop.

The endpoint exposes last-completed-round task counts, separate skip labels for
`not_claimable`, `unprofitable`, `no_executor`, and `other`, the current keeper
balance, last-round duration, and cumulative RPC errors labeled by type. A
round builds its counts privately and publishes them together on `finish()`, so
a scrape never observes a partially updated round.
