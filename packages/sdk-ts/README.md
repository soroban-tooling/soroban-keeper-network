# Soroban Keeper Network TypeScript SDK

A TypeScript SDK for interacting with the Soroban Keeper Network Registry contract.

## Installation

```bash
npm install @soroban-keeper-network/sdk-ts @stellar/stellar-sdk
```

Note: `@stellar/stellar-sdk` is a peer dependency. You must install it separately in your project.

## Quick Start

```typescript
import { KeeperRegistryClient } from '@soroban-keeper-network/sdk-ts'

// Create a client
const client = new KeeperRegistryClient({
  contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
})
```

## Architecture

The SDK provides a base `KeeperRegistryClient` class that wraps the repetitive simulate-build-sign-submit dance into shared, reusable plumbing:

### Read-only Calls

Read-only contract calls are simulated without requiring a signer or submitting a transaction:

```typescript
protected async readCall(options: ReadCallOptions): Promise<xdr.ScVal>
```

- Builds a transaction envelope
- Simulates it via RPC
- Returns the simulated result (`retval`)
- No sequence number consumed, no fees, no transaction submitted

### Mutating Calls

Mutating contract calls require a signer and follow the full submit flow:

```typescript
protected async writeCall(options: WriteCallOptions): Promise<TransactionResult>
```

- Builds a transaction envelope
- Simulates it via RPC
- Assembles the transaction with simulation results
- Signs via the provided `SignerFn`
- Submits the signed transaction
- Polls for confirmation (max 30 attempts, 1s sleep between)
- Returns the transaction hash and result value

## Validation

The constructor validates all inputs immediately and fails fast with clear, actionable error messages:

- **contractId**: Must be a 56-character Stellar contract address starting with `C`
- **rpcUrl**: Must be a valid URL
- **networkPassphrase**: Must be a non-empty string

```typescript
// This will throw with a clear error message
try {
  const client = new KeeperRegistryClient({
    contractId: 'INVALID',
    rpcUrl: 'not-a-url',
    networkPassphrase: '',
  })
} catch (err) {
  console.error(err.message) // "Invalid contractId: \"INVALID\". Expected a Stellar..."
}
```

## Types

The SDK exports the following types for use in your application:

```typescript
interface KeeperRegistryClientConfig {
  contractId: string
  rpcUrl: string
  networkPassphrase: string
}

type SignerFn = (xdr: string) => Promise<string>

interface ReadCallOptions {
  method: string
  args?: xdr.ScVal[]
}

interface WriteCallOptions extends ReadCallOptions {
  sourceAccount: string
  signer: SignerFn
}

interface TransactionResult<T = xdr.ScVal> {
  result: T
  transactionHash: string
}
```

## Extending the Client

Subclasses extend `KeeperRegistryClient` to add typed methods for each contract entry point:

```typescript
import { KeeperRegistryClient, WriteCallOptions } from '@soroban-keeper-network/sdk-ts'
import { nativeToScVal } from '@stellar/stellar-sdk'

export class MyKeeperClient extends KeeperRegistryClient {
  async claimTask(
    keeper: string,
    taskId: bigint,
    sourceAccount: string,
    signer: SignerFn
  ) {
    return this.writeCall({
      method: 'claim_task',
      args: [
        nativeToScVal(keeper, { type: 'address' }),
        nativeToScVal(taskId, { type: 'u64' }),
      ],
      sourceAccount,
      signer,
    })
  }
}
```

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test        # Run tests once
npm run test:watch  # Watch mode
```

### Lint

```bash
npm run lint
```

## License

Apache License 2.0
