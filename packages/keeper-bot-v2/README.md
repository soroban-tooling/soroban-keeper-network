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
