# Keeper Bot v2

Soroban Keeper Network v2 bot with support for external secret managers and multi-account signing.

## Features

- **External Secret Manager Support**: Load signing keys from AWS Secrets Manager or environment variables
- **Redaction Discipline**: No signing key material ever appears in logs or error messages (issue #0268, #0217)
- **Multi-Account Ready**: Abstraction design supports future multi-account signing (issue #0255)
- **Type-Safe Configuration**: Explicit `SECRET_SOURCE` configuration with validation

## Installation

```bash
npm install @soroban-keeper-network/keeper-bot-v2
```

## Quick Start

### Using Environment Variables (Default)

The simplest setup for local development:

```bash
export KEEPER_SECRET_KEY=S...  # Your Stellar Ed25519 secret seed
```

```typescript
import { createSecretSource } from "@soroban-keeper-network/keeper-bot-v2";

const source = createSecretSource();
const keypair = await source.getSigningKey();
```

### Using AWS Secrets Manager

For production deployments:

```bash
export SECRET_SOURCE=aws-secrets-manager
export AWS_SECRET_NAME=my-keeper-secret
export AWS_REGION=us-east-1
```

```typescript
import { createSecretSource } from "@soroban-keeper-network/keeper-bot-v2";

const source = createSecretSource();
const keypair = await source.getSigningKey();
```

First install the AWS SDK:
```bash
npm install @aws-sdk/client-secrets-manager
```

## Configuration

### Environment Variables

#### `SECRET_SOURCE` (optional)
- Default: `env`
- Values: `env`, `aws-secrets-manager`
- Controls which secret source is used

#### For `SECRET_SOURCE=env`
- `KEEPER_SECRET_KEY` (or custom via `KEEPER_SECRET_KEY_ENV_VAR`)
- Must be a valid Stellar Ed25519 secret seed (starts with `S`)
- Example: `SCMY3XYZZUQ6KWUC4MGIXVSPJ74QVVVZVZQPV5CVZVDSJ67OFPO7OAH`

#### For `SECRET_SOURCE=aws-secrets-manager`
- `AWS_SECRET_NAME` (required)
  - The secret name in AWS Secrets Manager
  - Must contain a plain text Stellar Ed25519 secret seed
- `AWS_REGION` (optional)
  - Default: `us-east-1`
  - AWS region where the secret is stored

### Programmatic Configuration

```typescript
import {
  createSecretSource,
  SecretSourceConfig,
} from "@soroban-keeper-network/keeper-bot-v2";

// Environment variable source
const envConfig: SecretSourceConfig = {
  type: "env",
  envVar: "KEEPER_SECRET_KEY", // optional, defaults to KEEPER_SECRET_KEY
};

// AWS Secrets Manager source
const awsConfig: SecretSourceConfig = {
  type: "aws-secrets-manager",
  secretName: "my-keeper-secret",
  region: "us-east-1", // optional
};

const source = createSecretSource(envConfig);
const keypair = await source.getSigningKey();
```

## Security

### Redaction Discipline

This package applies issue #0217's redaction discipline to prevent accidental exposure of signing keys:

- **No raw secrets in logs**: The signing key never appears in console output, error messages, or debug representations
- **No secrets in errors**: Errors include only the source description (e.g., "environment variable KEEPER_SECRET_KEY"), not the actual key
- **Error cause chains scrubbed**: AWS Secrets Manager error responses are sanitized to remove any accidentally-returned secrets
- **Configuration is safe**: The config object itself never contains the actual secret — only the source specification

### Production Recommendations

1. **Use AWS Secrets Manager** for real funds deployments, not plain environment variables
2. **Rotate secrets regularly** using AWS Secrets Manager's rotation features
3. **Monitor access** to secrets via AWS CloudTrail
4. **Use IAM roles** rather than long-lived access keys for the keeper bot
5. **Never commit secrets** to version control — use `.gitignore` for `.env` files

## API

### `createSecretSource(config?: SecretSourceConfig): SecretSource`

Creates a SecretSource from configuration.

**Parameters:**
- `config` (optional): Explicit configuration object. If omitted, reads from environment variables (`SECRET_SOURCE`, etc.)

**Returns:** A SecretSource instance (EnvSecretSource or AwsSecretsManagerSource)

**Throws:** `SecretSourceError` if configuration is invalid or the source cannot be initialized

**Example:**
```typescript
const source = createSecretSource({ type: "env" });
const keypair = await source.getSigningKey();
```

### `validateSecretSourceStartup(config?: SecretSourceConfig): Promise<void>`

Validates that a secret source is reachable and correctly configured (fails fast on startup).

Loads the signing key once to verify everything works, then discards it — the caller will request it again when needed.

**Parameters:**
- `config` (optional): Explicit configuration, or undefined to read from environment

**Throws:** `SecretSourceError` if the source is misconfigured or unreachable

**Example:**
```typescript
import { validateSecretSourceStartup } from "@soroban-keeper-network/keeper-bot-v2";

// Call during bot initialization
try {
  await validateSecretSourceStartup();
  console.log("Secret source validated successfully");
} catch (err) {
  console.error("Secret source configuration error:", err.message);
  process.exit(1);
}
```

### `SecretSource` Interface

```typescript
interface SecretSource {
  getSigningKey(): Promise<Keypair>;
}
```

Loads and returns a signing keypair for transaction signing.

**Throws:** `SecretSourceError` if loading fails

### `SecretSourceError`

Extended Error class with context about which source type failed and why.

**Properties:**
- `sourceType`: The type of source that failed (e.g., "env", "aws-secrets-manager")
- `message`: Human-readable error message (never includes the actual secret)
- `cause`: Original underlying error (also scrubbed)

## Architecture

The `SecretSource` abstraction provides a pluggable interface for loading signing keys from multiple sources without the rest of the codebase needing to know the source's details.

```
┌─────────────────────────────────────────┐
│   Keeper Bot Application                │
└────────────────┬────────────────────────┘
                 │
                 ├─ createSecretSource()
                 │
        ┌────────▼──────────┐
        │  SecretSource      │ (interface)
        │ getSigningKey()    │
        └────────┬──────────┘
                 │
      ┌──────────┴──────────┐
      │                     │
┌─────▼──────┐      ┌──────▼─────────────┐
│   EnvSource│      │ AwsSecretsManager   │
│ KEEPER_    │      │ Source              │
│ SECRET_KEY │      │ (AWS_SECRET_NAME)   │
└────────────┘      └─────────────────────┘
```

This design:
- Makes the secret source **explicit and configurable**
- Enables future support for **multi-account signing** (issue #0255)
- **Never exposes secrets** in error messages or logs
- Allows **lazy loading** of AWS SDK (only loaded if AWS source is used)

## Testing

Run the test suite:

```bash
npm test
```

The test suite includes:
- **Unit tests** for both EnvSecretSource and AwsSecretsManagerSource
- **Configuration tests** verifying correct source selection
- **Redaction tests** asserting that no signing key material appears in error messages or logs
- **Boundary tests** ensuring switching `SECRET_SOURCE` correctly changes which source is used

### Key Test: Redaction Verification

The `redaction.test.ts` file contains comprehensive tests that:
1. Capture all console output (log, warn, error)
2. Intentionally trigger errors in secret loading
3. Assert that the raw secret bytes **never appear** in any error message or log output

This matches issue #0217's redaction discipline for the Rust SDK.

## Integration with Keeper Bot

Example integration in the main keeper bot:

```typescript
import {
  createSecretSource,
  validateSecretSourceStartup,
} from "@soroban-keeper-network/keeper-bot-v2";

async function initializeBot() {
  // Validate secret source on startup
  await validateSecretSourceStartup();

  // Create the source
  const secretSource = createSecretSource();

  // Load the keypair when needed
  const keypair = await secretSource.getSigningKey();

  // Use for signing transactions
  const client = new KeeperRegistryClient({
    keypair,
    contractId: process.env.REGISTRY_CONTRACT_ID,
    networkPassphrase: Networks.TESTNET_FUTURE,
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  // ... rest of bot logic
}
```

## Future Work

- **Multi-account support** (issue #0255): Extend the abstraction to support loading multiple keypairs from different sources
- **Additional providers**: Add support for Google Cloud Secret Manager, HashiCorp Vault, etc.
- **Secret rotation**: Automatic key rotation without bot restart
- **Key derivation**: Support hierarchical deterministic key generation

## License

Apache License 2.0
