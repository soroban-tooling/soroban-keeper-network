import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EnvSecretSource } from "./env-source";
import { SecretSourceError } from "./types";

describe("EnvSecretSource", () => {
  let testSecret: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testSecret = Keypair.random().secret();
  });

  afterEach(() => {
    // Restore environment
    Object.keys(savedEnv).forEach((key) => {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  function setEnv(key: string, value: string | undefined) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it("should load a valid secret from the default KEEPER_SECRET_KEY env var", async () => {
    setEnv("KEEPER_SECRET_KEY", testSecret);
    const source = new EnvSecretSource({ type: "env" });
    const keypair = await source.getSigningKey();
    expect(keypair.secret()).toBe(testSecret);
  });

  it("should load a valid secret from a custom env var", async () => {
    setEnv("MY_CUSTOM_SECRET", testSecret);
    const source = new EnvSecretSource({
      type: "env",
      envVar: "MY_CUSTOM_SECRET",
    });
    const keypair = await source.getSigningKey();
    expect(keypair.secret()).toBe(testSecret);
  });

  it("should throw SecretSourceError when env var is not set", async () => {
    setEnv("KEEPER_SECRET_KEY", undefined);
    const source = new EnvSecretSource({ type: "env" });
    await expect(source.getSigningKey()).rejects.toThrow(SecretSourceError);
  });

  it("should throw SecretSourceError for invalid secret format", async () => {
    setEnv("KEEPER_SECRET_KEY", "not-a-valid-secret");
    const source = new EnvSecretSource({ type: "env" });
    await expect(source.getSigningKey()).rejects.toThrow(SecretSourceError);
  });

  it("should never expose the raw secret in error messages", async () => {
    const badSecret = "S" + "X".repeat(55);
    setEnv("KEEPER_SECRET_KEY", badSecret);
    const source = new EnvSecretSource({ type: "env" });

    try {
      await source.getSigningKey();
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof SecretSourceError) {
        expect(err.message).not.toContain(badSecret);
        expect(err.message).toContain("KEEPER_SECRET_KEY");
      }
    }
  });

  it("should handle empty string env var", async () => {
    setEnv("KEEPER_SECRET_KEY", "");
    const source = new EnvSecretSource({ type: "env" });
    await expect(source.getSigningKey()).rejects.toThrow(SecretSourceError);
  });
});
