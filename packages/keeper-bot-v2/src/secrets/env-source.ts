/**
 * Environment variable secret source.
 *
 * Loads signing keys from a plain environment variable.
 * This is the default for local development and testing.
 * Maintains backward compatibility with v1's KEEPER_SECRET_KEY.
 */

import {
  SecretSource,
  SecretSourceError,
  EnvSecretSourceConfig,
  validateSecretSeed,
  createKeypair,
} from "./types";
import { Keypair } from "@stellar/stellar-sdk";

export class EnvSecretSource implements SecretSource {
  private envVar: string;

  constructor(config: EnvSecretSourceConfig) {
    this.envVar = config.envVar ?? "KEEPER_SECRET_KEY";
  }

  async getSigningKey(): Promise<Keypair> {
    const rawSecret = process.env[this.envVar];
    const validated = validateSecretSeed(
      rawSecret,
      `environment variable ${this.envVar}`,
    );
    return createKeypair(validated, `environment variable ${this.envVar}`);
  }
}
