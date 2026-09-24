/**
 * Secret source abstraction for keeper-bot-v2.
 *
 * Provides a pluggable interface for loading signing keys from various sources:
 * - Plain environment variables (default for local development)
 * - AWS Secrets Manager
 * - Other cloud providers (extensible)
 *
 * Follows issue #0268 requirements and applies issue #0217's redaction discipline:
 * no secret key material ever appears in logs, error messages, or debug output.
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";

/**
 * Configuration for a secret source.
 *
 * Each source type has its own configuration shape. The union of all possible
 * configs allows callers to provide a single config object that works for any
 * source type.
 */
export type SecretSourceConfig =
  | EnvSecretSourceConfig
  | AwsSecretsManagerSourceConfig;

/**
 * Configuration for the environment variable secret source.
 *
 * This is the default for local development and testing.
 */
export interface EnvSecretSourceConfig {
  type: "env";
  /**
   * Environment variable name containing the signing key (default: KEEPER_SECRET_KEY).
   * Must be a valid Stellar Ed25519 secret seed (starts with 'S').
   */
  envVar?: string;
}

/**
 * Configuration for AWS Secrets Manager source.
 *
 * The secret in AWS Secrets Manager should be a plain text string containing
 * a valid Stellar Ed25519 secret seed (starts with 'S').
 */
export interface AwsSecretsManagerSourceConfig {
  type: "aws-secrets-manager";
  /** Secret name in AWS Secrets Manager (required) */
  secretName: string;
  /** AWS region (default: from AWS_REGION env var or us-east-1) */
  region?: string;
}

/**
 * Interface for loading signing keys from a secret source.
 *
 * Implementations are responsible for:
 * - Loading the raw secret material from their source
 * - Validating it as a Stellar Ed25519 secret seed
 * - Returning a Keypair for signing operations
 * - Never logging or exposing the raw secret material anywhere
 *
 * This abstraction enables future support for multi-account pools (issue #0255),
 * where different accounts might load from different sources.
 */
export interface SecretSource {
  /**
   * Loads and returns a signing keypair.
   *
   * @returns A keypair ready for signing transactions
   * @throws {SecretSourceError} if loading fails, the secret is invalid,
   *   or the configured source is unreachable/misconfigured
   */
  getSigningKey(): Promise<Keypair>;
}

/**
 * Error thrown when secret loading fails.
 *
 * Never includes the raw secret material. Includes only:
 * - The source type and configuration (without credentials)
 * - The reason for failure
 * - A cause chain for debugging (also scrubbed)
 */
export class SecretSourceError extends Error {
  constructor(
    readonly sourceType: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SecretSourceError";
  }
}

/**
 * Validates a string as a Stellar Ed25519 secret seed.
 *
 * Used by all sources to validate before returning a Keypair.
 * Logs no information about the actual secret value, only whether it's valid.
 *
 * @param rawSecret The raw secret string to validate
 * @param description Human-readable description of the secret source (e.g., "environment variable KEEPER_SECRET_KEY")
 * @throws {SecretSourceError} if the secret is not a valid Ed25519 seed
 * @returns The same secret (not modified)
 */
export function validateSecretSeed(
  rawSecret: string | undefined,
  description: string,
): string {
  if (!rawSecret || rawSecret === "") {
    throw new SecretSourceError(
      "validation",
      `Secret not found: ${description}`,
    );
  }

  if (!StrKey.isValidEd25519SecretSeed(rawSecret)) {
    throw new SecretSourceError(
      "validation",
      `Invalid secret seed format from ${description}: must be a valid Stellar Ed25519 secret seed (starts with 'S')`,
    );
  }

  return rawSecret;
}

/**
 * Creates a Keypair from a validated secret, with redaction in error paths.
 *
 * Never logs the raw secret. If keypair creation fails, the error message
 * contains only the source description, not the secret itself.
 *
 * @param secret A validated Ed25519 secret seed
 * @param description Human-readable description of the secret source
 * @returns A Keypair ready for signing
 * @throws {SecretSourceError} if the keypair cannot be created
 */
export function createKeypair(
  secret: string,
  description: string,
): Keypair {
  try {
    return Keypair.fromSecret(secret);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new SecretSourceError(
      "keypair-creation",
      `Failed to create keypair from ${description}: ${errorMsg}`,
      { cause: err },
    );
  }
}
