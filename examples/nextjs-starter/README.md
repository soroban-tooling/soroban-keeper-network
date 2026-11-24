# Next.js Keeper Network Starter

A starter web application demonstrating how to connect a Stellar wallet, register automated tasks, and track real-time task status using `@soroban-keeper-network/sdk` React hooks on Stellar Testnet.

## Features

- **Public SDK Entry Points Only**: Uses `@soroban-keeper-network/sdk` and `@soroban-keeper-network/sdk/react` without relying on internal contract bindings or private modules.
- **Stellar Wallet Connection**: Connect button with state management for Freighter or injected Stellar wallets.
- **Task Registration Form**: Uses `useRegisterTask` hook to register automated tasks with customizable task types, rewards, and deadlines.
- **Live Task Status & Events**: Uses `useTask` and `useTaskEvents` hooks to poll on-chain state, lifecycle statuses (`Pending`, `Claimed`, `Executed`), and execution events.

## Environment Variables

Copy `.env.example` to `.env.local` to run against Stellar Testnet:

```bash
cp .env.example .env.local
```

### Required Variables

| Variable | Description | Testnet Default |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | Stellar network identifier | `testnet` |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Network passphrase | `Test SDF Network ; September 2015` |
| `NEXT_PUBLIC_KEEPER_REGISTRY_ADDRESS` | Deployed Keeper Registry address | `CA3D5KRYMCMCZWPT2PBN6CKP3F73S6XQPO2U2R44K64W74UBWLDN7426` |
| `NEXT_PUBLIC_POLL_INTERVAL_MS` | Hook polling frequency in ms | `3000` |

## Getting Started

Install dependencies and start the local development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Running Tests

```bash
npm test --prefix examples/nextjs-starter
```
