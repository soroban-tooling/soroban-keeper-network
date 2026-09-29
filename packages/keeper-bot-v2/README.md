# Keeper Bot v2

Production-grade Soroban Keeper Network bot for competitive operators.

This package is v2 of the keeper bot, aimed at operators running keepers competitively at scale. It features:

- **Persistent state**: Task outcomes survive restarts; prevents double-claiming
- **Concurrent task processing**: Multiple tasks in flight within a single round
- **Pluggable executors**: Register custom executors by task type
- **Runtime inspection**: CLI commands to query a live running bot's state without restart
- **Secret hygiene**: Configuration redaction following established best practices
- **Profitability checks**: Skip tasks that won't turn a profit

## Quick Start

```bash
npm install @soroban-keeper-network/keeper-bot-v2

# Create .env (see .env.example)
cp .env.example .env

# Run the bot
npm start

# Inspect the bot's state (in another terminal)
keeper-bot inspect config
keeper-bot inspect task 42
keeper-bot inspect skip-decisions --limit 50
```

## For Newcomers

If you're new to keeper bots, start with [`examples/keeper-bot`](../../examples/keeper-bot) instead. That's a single-file, beginner-friendly version designed to teach the concepts. v2 is for operators who understand the basics and need production features.

## CLI Commands

### `keeper-bot start`

Start the keeper bot daemon (or `--once` for a single round).

```bash
keeper-bot start
keeper-bot start --once
```

### `keeper-bot inspect config`

Dump the current runtime configuration with secrets redacted.

```bash
keeper-bot inspect config
```

### `keeper-bot inspect task <task-id>`

Query persisted state for a specific task.

```bash
keeper-bot inspect task 42
```

### `keeper-bot inspect skip-decisions [--limit N]`

Show recent skip decisions and their reasons.

```bash
keeper-bot inspect skip-decisions --limit 50
```

## Configuration

See `.env.example` for all available configuration options. Configuration is loaded from environment variables and validated at startup, following the same patterns as v1.

### Secret Redaction

Configuration dumps redact:

- Signing keys (`KEEPER_SECRET_KEY`)
- Tokens and credentials
- Sensitive environment values

Redaction is centralized and applied consistently across all inspection output.

## Architecture

- **Persistence**: SQLite database with schema migrations
- **CLI**: Commander.js for command routing
- **State**: In-memory + persistent tracking of task outcomes
- **Inspection**: Direct database queries, no restart required

## Development

```bash
npm run build
npm run test
npm run lint
npm run dev        # Watch mode
```

## License

Apache 2.0

## See Also

- [`examples/keeper-bot`](../../examples/keeper-bot) — Beginner-friendly single-file reference
- [`packages/sdk-ts`](../sdk-ts) — TypeScript SDK
- [`docs/KEEPER_BOT_V2_DESIGN.md`](../../docs/KEEPER_BOT_V2_DESIGN.md) — Design decisions
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

## Metrics

`KeeperMetrics` publishes Prometheus text at `/metrics` through a dedicated HTTP
server. The default bind is `127.0.0.1:9464`. The scrape handler only reads the
in-memory registry; it does not call RPC or wait for the keeper loop.

The endpoint exposes last-completed-round task counts, separate skip labels for
`not_claimable`, `unprofitable`, `no_executor`, and `other`, the current keeper
balance, last-round duration, and cumulative RPC errors labeled by type. A
round builds its counts privately and publishes them together on `finish()`, so
a scrape never observes a partially updated round.
