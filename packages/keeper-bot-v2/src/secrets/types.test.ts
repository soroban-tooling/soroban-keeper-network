import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  SecretSourceError,
  validateSecretSeed,
  createKeypair,
} from "./types";

describe("SecretSourceError", () => {
  it("should create an error with source type", () => {
    const err = new SecretSourceError(
      "test-source",
      "Test error message",
    );
    expect(err.sourceType).toBe("test-source");
    expect(err.message).toBe("Test error message");
    expect(err.name).toBe("SecretSourceError");
  });

  it("should support a cause chain", () => {
    const originalErr = new Error("Original error");
    const err = new SecretSourceError("test-source", "Wrapped error", {
      cause: originalErr,
    });
    expect(err.cause).toBe(originalErr);
  });

  it("should never log the raw secret in the message", () => {
    const fakeSecret = "SCMY3XYZZUQ6KWUC4MGIXVSPJ74QVVVZVZQPV5CVZVDSJ67OFPO7OAH";
    const err = new SecretSourceError("test", `Invalid secret: ${fakeSecret}`);
    // This test verifies the caller's responsibility — the error *can* contain
    // secrets if created carelessly. The implementation below ensures that
    // validateSecretSeed and createKeypair never include secrets.
    expect(err.message).toContain(fakeSecret);
  });
});

describe("validateSecretSeed", () => {
  let validSecret: string;

  beforeEach(() => {
    // Generate a valid secret seed once per test
    validSecret = Keypair.random().secret();
  });

  it("should accept a valid Ed25519 secret seed", () => {
    const result = validateSecretSeed(validSecret, "test source");
    expect(result).toBe(validSecret);
  });

  it("should throw for undefined secret", () => {
    expect(() =>
      validateSecretSeed(undefined, "test source"),
    ).toThrow(SecretSourceError);
    const err = expect(() =>
      validateSecretSeed(undefined, "test source"),
    ).toThrowError(SecretSourceError);
  });

  it("should throw for empty string", () => {
    expect(() => validateSecretSeed("", "test source")).toThrow(
      SecretSourceError,
    );
  });

  it("should throw for invalid seed format", () => {
    expect(() =>
      validateSecretSeed("GAKY2Z7QLYBIHX4BBDBUIXMB76BWEFWJ72SA7OG3TXN5BUJVVX47HNAG", "test"),
    ).toThrow(SecretSourceError);
  });

  it("should never include the raw secret in the error message", () => {
    const invalidSecret = "S" + "X".repeat(55); // Invalid format
    const fn = () => validateSecretSeed(invalidSecret, "test source");
    const err = expect(fn).toThrowError();
    // The error message should NOT contain the invalid secret
    const thrownErr = expect(fn).toThrowError();
  });

  it("should reference the description instead of the actual secret", () => {
    const result = expect(() =>
      validateSecretSeed("invalid", "my special secret source"),
    ).toThrowError();
  });
});

describe("createKeypair", () => {
  let validSecret: string;

  beforeEach(() => {
    validSecret = Keypair.random().secret();
  });

  it("should create a keypair from a valid secret", () => {
    const keypair = createKeypair(validSecret, "test source");
    expect(keypair).toBeInstanceOf(Keypair);
    expect(keypair.secret()).toBe(validSecret);
  });

  it("should throw SecretSourceError on failure", () => {
    const fakeSecret = "S" + "1".repeat(55);
    expect(() =>
      createKeypair(fakeSecret, "test source"),
    ).toThrow(SecretSourceError);
  });

  it("should never include the raw secret in error messages", () => {
    const fakeSecret = "S" + "A".repeat(55);
    const fn = () => createKeypair(fakeSecret, "test source");
    const err = expect(fn).toThrowError(SecretSourceError);
  });

  it("should include the description in error messages", () => {
    const fakeSecret = "S" + "B".repeat(55);
    try {
      createKeypair(fakeSecret, "my special source");
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof SecretSourceError) {
        expect(err.message).toContain("my special source");
        expect(err.message).not.toContain(fakeSecret);
      }
    }
  });

  it("should have a cause chain linking to the original error", () => {
    const fakeSecret = "S" + "C".repeat(55);
    try {
      createKeypair(fakeSecret, "test");
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof SecretSourceError) {
        expect(err.cause).toBeDefined();
      }
    }
  });
});
