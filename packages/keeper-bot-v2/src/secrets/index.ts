/**
 * Secrets module for keeper-bot-v2.
 *
 * Exports the public SecretSource interface and factory for creating sources.
 * Implementation details (EnvSecretSource, AwsSecretsManagerSource) are internal.
 */

export type {
  SecretSource,
  SecretSourceConfig,
  EnvSecretSourceConfig,
  AwsSecretsManagerSourceConfig,
} from "./types";
export { SecretSourceError } from "./types";
export { createSecretSource, validateSecretSourceStartup } from "./factory";
