# Task Owner Script Template

A minimal, production-ready script template for task owners to register an automation task on the Soroban Keeper Network, wait for execution by keepers, and handle deadline expiry.

## Features

- **Strictly under 100 lines** using `@soroban-keeper-network/sdk`.
- **Automatic deadline expiry handling**: If keepers do not execute the task before the deadline expires, the script automatically triggers `expireTask` to refund escrowed rewards back to the owner.
- **Robust polling**: Watches task status with configurable poll interval and timeouts.

## Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure your funded owner secret key and registry contract address in `.env`:
   ```env
   OWNER_SECRET_KEY=S...
   REGISTRY_CONTRACT_ID=C...
   RPC_URL=https://soroban-testnet.stellar.org
   NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
   ```
3. Install dependencies and run:
   ```bash
   npm install
   npm run build
   npm start
   ```

## Running Tests

Run the test suite covering execution, deadline timeout expiry, and cancellation:
```bash
npm test
```
