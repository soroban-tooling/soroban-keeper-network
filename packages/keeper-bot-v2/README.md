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
