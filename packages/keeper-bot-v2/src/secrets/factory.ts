/**
 * Factory for creating SecretSource instances.
 *
 * Handles configuration parsing, source selection, and validation.
 */

import { SecretSource, SecretSourceConfig, SecretSourceError } from "./types";
import { EnvSecretSource } from "./env-source";
import { AwsSecretsManagerSource } from "./aws-source";

/**
 * Creates a SecretSource from configuration.
 *
 * The SECRET_SOURCE environment variable (or config.type) determines which
 * source is used:
 * - "env" (default): Environment variable source
 * - "aws-secrets-manager": AWS Secrets Manager source
 *
 * @param config Explicit configuration, or undefined to read from environment
 * @returns A configured SecretSource instance
 * @throws {SecretSourceError} if the configuration is invalid or the source
 *   cannot be initialized
 */
export function createSecretSource(
  config?: SecretSourceConfig,
): SecretSource {
  // If no explicit config, try to create from environment
  if (!config) {
    const sourceType = process.env.SECRET_SOURCE ?? "env";
    return createSecretSource(configFromSourceType(sourceType));
  }

  switch (config.type) {
    case "env":
      return new EnvSecretSource(config);
    case "aws-secrets-manager":
      return new AwsSecretsManagerSource(config);
    default:
      throw new SecretSourceError(
        "factory",
        `Unknown secret source type: "${(config as any).type}". Supported types: env, aws-secrets-manager`,
      );
  }
}

/**
 * Converts a SECRET_SOURCE environment variable value into a config object.
 *
 * Handles the "env" and "aws-secrets-manager" cases, with required additional
 * configuration read from environment variables.
 *
 * For "aws-secrets-manager", requires:
 * - AWS_SECRET_NAME: The secret name in AWS Secrets Manager
 * - AWS_REGION (optional): AWS region (defaults to us-east-1)
 *
 * @param sourceType Value of SECRET_SOURCE environment variable
 * @returns A configuration object
 * @throws {SecretSourceError} if required environment variables are missing
 */
function configFromSourceType(sourceType: string): SecretSourceConfig {
  switch (sourceType) {
    case "env":
      return {
        type: "env",
        envVar: process.env.KEEPER_SECRET_KEY_ENV_VAR ?? "KEEPER_SECRET_KEY",
      };
    case "aws-secrets-manager":
      const secretName = process.env.AWS_SECRET_NAME;
      if (!secretName) {
        throw new SecretSourceError(
          "factory",
          'SECRET_SOURCE=aws-secrets-manager requires AWS_SECRET_NAME environment variable',
        );
      }
      return {
        type: "aws-secrets-manager",
        secretName,
        region: process.env.AWS_REGION,
      };
    default:
      throw new SecretSourceError(
        "factory",
        `Unknown SECRET_SOURCE: "${sourceType}". Supported values: env, aws-secrets-manager`,
      );
  }
}

/**
 * Initializes a SecretSource and validates it works (fails fast on startup).
 *
 * This is typically called during bot startup to catch configuration errors
 * before the main loop begins. It loads the signing key once, validates it,
 * but discards it — the caller will call getSigningKey() again when needed.
 *
 * @param config Secret source configuration
 * @throws {SecretSourceError} if the source is misconfigured or unreachable
 */
export async function validateSecretSourceStartup(
  config?: SecretSourceConfig,
): Promise<void> {
  const source = createSecretSource(config);
  try {
    // Load the key once to validate the source is reachable and configured
    // Don't store it; the caller will request it again when signing is needed
    await source.getSigningKey();
  } catch (err) {
    // If validation fails, re-throw as-is (already a SecretSourceError)
    throw err;
  }
}
