# Node.js secret-key signing example

Demonstrates using `@soroban-keeper-network/sdk` from a server-side Node
script that signs transactions directly with a `Keypair` loaded from an
environment variable — the pattern `examples/keeper-bot` already uses in
production, for automation contexts (cron jobs, serverless functions, a
keeper daemon) where a browser wallet-extension flow doesn't apply.

## Setup

```bash
cd packages/sdk-ts
npm install && npm run build   # build the SDK itself first

cd examples/node-signing
npm install
cp .env.example .env           # fill in your real values — see .env.example
npm start
```

## What it does

`claim-task.ts` claims one task (`TASK_ID` from your `.env`) on the
configured `KeeperRegistry` contract, using `KeeperRegistryClient.invoke()`
wrapped in `withRetry()` for transient-failure resilience, and demonstrates
typed contract-error handling via `decodeKeeperError()`/`isKeeperError()`
(see `../../src/errors.ts`) rather than pattern-matching on raw error
message text.

## Secret handling

Follows the same convention `examples/keeper-bot/.env.example` establishes:
the secret key is **never** hardcoded in the example itself — only read
from `process.env.KEEPER_SECRET_KEY`, loaded via `dotenv` from a local
`.env` file that is (and must stay) out of version control.
