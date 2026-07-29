/**
 * Test suite for isPermanentError()
 *
 * This function determines whether an error should abort the retry loop
 * immediately or allow retries. Getting this wrong means either wasting
 * gas/fees retrying operations that can never succeed, or giving up too
 * soon on transient failures.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { isPermanentError } = require("../index.js");

describe("isPermanentError", () => {
  describe("permanent errors (should return true)", () => {
    it("recognizes simulation failed errors", () => {
      const err = new Error("Simulation failed: InvalidAction");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("recognizes simulation failed with lowercase", () => {
      const err = new Error("simulation failed: contract returned error");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("recognizes invalidaction errors", () => {
      const err = new Error("Transaction failed: InvalidAction");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("recognizes unauthorized errors", () => {
      const err = new Error("Unauthorized: keeper not registered");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("recognizes already claimed errors", () => {
      const err = new Error("Task already claimed by another keeper");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("recognizes already executed errors", () => {
      const err = new Error("Task already executed");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("handles mixed case in error messages", () => {
      const err = new Error("SIMULATION FAILED");
      assert.strictEqual(isPermanentError(err), true);
    });
  });

  describe("retryable errors (should return false)", () => {
    it("treats network timeout as retryable", () => {
      const err = new Error("Network timeout");
      assert.strictEqual(isPermanentError(err), false);
    });

    it("treats connection refused as retryable", () => {
      const err = new Error("Connection refused");
      assert.strictEqual(isPermanentError(err), false);
    });

    it("treats RPC unavailable as retryable", () => {
      const err = new Error("RPC server unavailable");
      assert.strictEqual(isPermanentError(err), false);
    });

    it("treats transaction not found as retryable", () => {
      const err = new Error("Transaction not found");
      assert.strictEqual(isPermanentError(err), false);
    });

    it("treats ledger not available as retryable", () => {
      const err = new Error("Ledger not available yet");
      assert.strictEqual(isPermanentError(err), false);
    });
  });

  describe("edge cases", () => {
    it("returns false for null", () => {
      assert.strictEqual(isPermanentError(null), false);
    });

    it("returns false for undefined", () => {
      assert.strictEqual(isPermanentError(undefined), false);
    });

    it("returns false for error without message", () => {
      const err = new Error();
      assert.strictEqual(isPermanentError(err), false);
    });

    it("returns false for non-Error objects with message property", () => {
      const obj = { message: "simulation failed" };
      assert.strictEqual(isPermanentError(obj), true);
    });

    it("returns false for empty error message", () => {
      const err = new Error("");
      assert.strictEqual(isPermanentError(err), false);
    });

    it("returns false for generic error message", () => {
      const err = new Error("Something went wrong");
      assert.strictEqual(isPermanentError(err), false);
    });
  });

  describe("substring matching behavior", () => {
    it("matches 'already' anywhere in message", () => {
      const err = new Error("The task was already processed by keeper");
      assert.strictEqual(isPermanentError(err), true);
    });

    it("does not match 'simulate' without 'simulation failed'", () => {
      const err = new Error("Cannot simulate right now");
      assert.strictEqual(isPermanentError(err), false);
    });

    it("requires complete phrase 'simulation failed'", () => {
      const err = new Error("simulation succeeded");
      assert.strictEqual(isPermanentError(err), false);
    });
  });
});
