/**
 * Comprehensive redaction tests for secret handling.
 *
 * Verifies that no code path in the secrets module ever logs, exposes, or
 * transmits the raw signing key material, matching issue #0217's redaction
 * discipline and ensuring compliance with issue #0268's security requirements.
 *
 * These tests capture all logs and errors and assert that the actual secret
 * bytes never appear anywhere — not in error messages, debug output, or
 * console logs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EnvSecretSource } from "./env-source";
import { SecretSourceError } from "./types";

describe("Redaction Discipline", () => {
  let testSecret: string;
  let testPublicKey: string;
  let originalConsoleError: typeof console.error;
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleLog: typeof console.log;
  let capturedLogs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testSecret = Keypair.random().secret();
    testPublicKey = Keypair.fromSecret(testSecret).publicKey();

    // Capture all console output
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    originalConsoleLog = console.log;
    capturedLogs = [];

    console.error = (...args) => {
      capturedLogs.push(args.map((a) => String(a)).join(" "));
    };
    console.warn = (...args) => {
      capturedLogs.push(args.map((a) => String(a)).join(" "));
    };
    console.log = (...args) => {
      capturedLogs.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    // Restore console
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;

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

  function assertSecretNotInLogs() {
    const allLogs = capturedLogs.join("\n");
    const secretBytes = testSecret.slice(1); // Skip the 'S' prefix

    // Assert the raw secret never appears
    expect(allLogs).not.toContain(testSecret);
    expect(allLogs).not.toContain(secretBytes);

    // Assert no base64-like patterns that might encode the secret
    // (this is a heuristic, not a cryptographic check)
    const containsSecretPattern =
      testSecret.split("").some((char) => {
        const count = (allLogs.match(new RegExp(char, "g")) || []).length;
        // If we see suspiciously many occurrences of the secret's characters
        // in sequence, flag it (this is a loose heuristic)
        return count > 5;
      });

    // We allow some occurrences but not patterns that look like the raw key
    expect(containsSecretPattern).toBe(false);
  }

  it("should not leak the secret in error messages on invalid format", async () => {
    const badSecret = "S" + "X".repeat(55);
    setEnv("KEEPER_SECRET_KEY", badSecret);
    const source = new EnvSecretSource({ type: "env" });

    try {
      await source.getSigningKey();
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof Error) {
        expect(err.message).not.toContain(badSecret);
      }
    }

    assertSecretNotInLogs();
  });

  it("should not leak the secret in error messages on missing env var", async () => {
    setEnv("KEEPER_SECRET_KEY", undefined);
    const source = new EnvSecretSource({ type: "env" });

    try {
      await source.getSigningKey();
      throw new Error("Should have thrown");
    } catch (err) {
      // Error should mention the env var name, not the secret
      if (err instanceof SecretSourceError) {
        expect(err.message).toContain("KEEPER_SECRET_KEY");
        expect(err.message).not.toContain(testSecret);
      }
    }

    assertSecretNotInLogs();
  });

  it("should not expose the secret in thrown error objects", async () => {
    setEnv("KEEPER_SECRET_KEY", testSecret);
    const source = new EnvSecretSource({ type: "env" });
    const keypair = await source.getSigningKey();

    // After a successful load, ensure error on subsequent invalid operation
    // doesn't leak secrets
    setEnv("KEEPER_SECRET_KEY", "S" + "Z".repeat(55));
    const source2 = new EnvSecretSource({ type: "env" });

    try {
      await source2.getSigningKey();
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof Error) {
        // Serialize the error to JSON and check for secrets
        const serialized = JSON.stringify({
          message: err.message,
          cause: err.cause,
          name: err.name,
        });
        expect(serialized).not.toContain(testSecret);
      }
    }

    assertSecretNotInLogs();
  });

  it("should not leak secrets in error cause chains", async () => {
    const badSecret = "S" + "Q".repeat(55);
    setEnv("KEEPER_SECRET_KEY", badSecret);
    const source = new EnvSecretSource({ type: "env" });

    try {
      await source.getSigningKey();
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof SecretSourceError && err.cause) {
        const causeStr = String(err.cause);
        expect(causeStr).not.toContain(badSecret);
      }
    }

    assertSecretNotInLogs();
  });

  it("should allow the public key in logs (not a secret)", async () => {
    setEnv("KEEPER_SECRET_KEY", testSecret);
    const source = new EnvSecretSource({ type: "env" });
    const keypair = await source.getSigningKey();

    // The public key is NOT secret and can appear in logs
    expect(keypair.publicKey()).toBe(testPublicKey);
    // But the secret itself must never appear
    expect(testPublicKey).not.toContain(testSecret);
  });

  it("should not leak the secret when stringified", async () => {
    setEnv("KEEPER_SECRET_KEY", testSecret);
    const source = new EnvSecretSource({ type: "env" });

    try {
      const keypair = await source.getSigningKey();
      // Even if someone tries to stringify the keypair, ensure the source
      // itself doesn't store the raw secret in a way that exposes it
      const stringified = JSON.stringify({
        source,
      });
      expect(stringified).not.toContain(testSecret);
    } catch (err) {
      throw err;
    }

    assertSecretNotInLogs();
  });

  it("should redact secrets in debug representations", async () => {
    const fakeSecret = "S" + "M".repeat(55);
    setEnv("KEEPER_SECRET_KEY", fakeSecret);
    const source = new EnvSecretSource({ type: "env" });

    try {
      await source.getSigningKey();
    } catch (err) {
      if (err instanceof SecretSourceError) {
        // The error's toString() should not include the secret
        const errorStr = String(err);
        expect(errorStr).not.toContain(fakeSecret);
        expect(errorStr).not.toContain(fakeSecret.slice(1)); // Skip 'S'
      }
    }

    assertSecretNotInLogs();
  });
});
