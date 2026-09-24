/**
 * AWS Secrets Manager secret source.
 *
 * Loads signing keys from AWS Secrets Manager.
 * Requires the @aws-sdk/client-secrets-manager package to be installed.
 */

import {
  SecretSource,
  SecretSourceError,
  AwsSecretsManagerSourceConfig,
  validateSecretSeed,
  createKeypair,
} from "./types";
import { Keypair } from "@stellar/stellar-sdk";

export class AwsSecretsManagerSource implements SecretSource {
  private secretName: string;
  private region: string;
  private client: InstanceType<any>; // Will be initialized lazily

  constructor(config: AwsSecretsManagerSourceConfig) {
    this.secretName = config.secretName;
    this.region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
  }

  /**
   * Lazy-loads the AWS SDK client on first use.
   * This allows keeper-bot-v2 to be used without AWS SDK installed
   * if only env-var sources are configured.
   */
  private async getAwsClient() {
    if (!this.client) {
      try {
        const { SecretsManagerClient } = await import(
          "@aws-sdk/client-secrets-manager"
        );
        this.client = new SecretsManagerClient({ region: this.region });
      } catch (err) {
        throw new SecretSourceError(
          "aws-secrets-manager",
          "@aws-sdk/client-secrets-manager is not installed. Install it with: npm install @aws-sdk/client-secrets-manager",
          { cause: err },
        );
      }
    }
    return this.client;
  }

  async getSigningKey(): Promise<Keypair> {
    try {
      const client = await this.getAwsClient();
      const { GetSecretValueCommand } = await import(
        "@aws-sdk/client-secrets-manager"
      );

      const command = new GetSecretValueCommand({
        SecretId: this.secretName,
      });

      const response = await client.send(command);

      // AWS Secrets Manager returns either SecretString (plain text) or SecretBinary
      const rawSecret = response.SecretString;
      if (!rawSecret) {
        throw new SecretSourceError(
          "aws-secrets-manager",
          `Secret "${this.secretName}" is empty or binary-only (must be plain text)`,
        );
      }

      const validated = validateSecretSeed(
        rawSecret,
        `AWS Secrets Manager secret "${this.secretName}"`,
      );
      return createKeypair(
        validated,
        `AWS Secrets Manager secret "${this.secretName}"`,
      );
    } catch (err) {
      // Re-throw if it's already a SecretSourceError
      if (err instanceof SecretSourceError) {
        throw err;
      }

      // Scrub AWS-specific error details that might leak the secret or credentials
      const errorMsg = err instanceof Error ? err.message : String(err);
      const scrubbedMsg = this.scrubAwsError(errorMsg);

      throw new SecretSourceError(
        "aws-secrets-manager",
        `Failed to load secret from AWS Secrets Manager (${this.secretName}): ${scrubbedMsg}`,
        { cause: err },
      );
    }
  }

  /**
   * Removes sensitive information from AWS error messages.
   * AWS SDK error messages may contain response bodies that could include
   * the secret value if AWS echoes it back in error responses.
   */
  private scrubAwsError(errorMsg: string): string {
    // Hide common AWS error details that might leak secrets
    return errorMsg
      .replace(/SecretString[:\s]+"[^"]*"/g, 'SecretString: "[redacted]"')
      .replace(/Body:\s*"[^"]*"/g, 'Body: "[redacted]"')
      .replace(/message:\s*"[^"]*"/g, 'message: "[redacted]"');
  }
}
