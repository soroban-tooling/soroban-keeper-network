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

## Executor plugins

Set `KEEPER_EXECUTOR_MODULES` to a comma-separated allow-list of local module
paths or installed package names. Each module exports one `TaskExecutor` as its
default export or as a named `executor` export. The loader validates plugins at
startup and rejects duplicate task-type registrations.

An executor declares `name`, `version`, and `taskTypes`, estimates its bounded
cost, and returns proof bytes after doing the underlying work. Returning `null`
refuses the task. There is deliberately no fallback that fabricates proof for
unknown task types; they emit `task_skipped_no_executor` and remain unclaimed.

`src/executors/ttl-extension.ts` is the reference non-simulated plugin. Its
calldata is UTF-8 JSON containing `contractId` and `extendToLedger`. It invokes
the core's TTL-extension submission capability with the stable idempotency key
and returns a proof tied to the submitted transaction hash.
