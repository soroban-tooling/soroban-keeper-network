import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createSecretSource,
  validateSecretSourceStartup,
} from "./factory";
import { SecretSourceError } from "./types";

describe("createSecretSource", () => {
  let testSecret: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testSecret = Keypair.random().secret();
  });

  afterEach(() => {
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

  it("should create an env source by default", () => {
    const source = createSecretSource({ type: "env" });
    expect(source).toBeDefined();
    expect(source.getSigningKey).toBeDefined();
  });

  it("should create an env source when no config is provided", () => {
    setEnv("SECRET_SOURCE", undefined);
    const source = createSecretSource();
    expect(source).toBeDefined();
  });

  it("should create an env source when SECRET_SOURCE=env", () => {
    setEnv("SECRET_SOURCE", "env");
    const source = createSecretSource();
    expect(source).toBeDefined();
  });

  it("should throw for unknown source type", () => {
    expect(() => createSecretSource({ type: "unknown" as any })).toThrow(
      SecretSourceError,
    );
  });

  it("should throw for aws-secrets-manager without AWS_SECRET_NAME", () => {
    setEnv("AWS_SECRET_NAME", undefined);
    expect(() => createSecretSource({ type: "aws-secrets-manager" as any })).toThrow(
      SecretSourceError,
    );
  });

  it("should throw for aws-secrets-manager when SECRET_SOURCE=aws-secrets-manager but AWS_SECRET_NAME not set", () => {
    setEnv("SECRET_SOURCE", "aws-secrets-manager");
    setEnv("AWS_SECRET_NAME", undefined);
    expect(() => createSecretSource()).toThrow(SecretSourceError);
  });

  it("should use KEEPER_SECRET_KEY_ENV_VAR if set", async () => {
    setEnv("SECRET_SOURCE", "env");
    setEnv("KEEPER_SECRET_KEY_ENV_VAR", "MY_CUSTOM_KEY");
    setEnv("MY_CUSTOM_KEY", testSecret);
    setEnv("KEEPER_SECRET_KEY", undefined);
    const source = createSecretSource();
    const keypair = await source.getSigningKey();
    expect(keypair.secret()).toBe(testSecret);
  });

  it("should default to KEEPER_SECRET_KEY if KEEPER_SECRET_KEY_ENV_VAR not set", async () => {
    setEnv("SECRET_SOURCE", "env");
    setEnv("KEEPER_SECRET_KEY_ENV_VAR", undefined);
    setEnv("KEEPER_SECRET_KEY", testSecret);
    const source = createSecretSource();
    const keypair = await source.getSigningKey();
    expect(keypair.secret()).toBe(testSecret);
  });
});

describe("validateSecretSourceStartup", () => {
  let testSecret: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testSecret = Keypair.random().secret();
  });

  afterEach(() => {
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

  it("should succeed with valid configuration", async () => {
    setEnv("KEEPER_SECRET_KEY", testSecret);
    await expect(
      validateSecretSourceStartup({ type: "env" }),
    ).resolves.toBeUndefined();
  });

  it("should throw with missing env var", async () => {
    setEnv("KEEPER_SECRET_KEY", undefined);
    await expect(
      validateSecretSourceStartup({ type: "env" }),
    ).rejects.toThrow(SecretSourceError);
  });

  it("should throw with invalid secret", async () => {
    setEnv("KEEPER_SECRET_KEY", "invalid");
    await expect(
      validateSecretSourceStartup({ type: "env" }),
    ).rejects.toThrow(SecretSourceError);
  });

  it("should never expose the raw secret in error messages", async () => {
    const badSecret = "S" + "Y".repeat(55);
    setEnv("KEEPER_SECRET_KEY", badSecret);

    try {
      await validateSecretSourceStartup({ type: "env" });
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof SecretSourceError) {
        expect(err.message).not.toContain(badSecret);
      }
    }
  });
});
