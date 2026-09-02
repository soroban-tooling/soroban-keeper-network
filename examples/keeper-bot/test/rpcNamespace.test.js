/**
 * Regression tests for the Soroban RPC namespace the bot is built on.
 *
 * @stellar/stellar-sdk v16 removed the `SorobanRpc` alias in favour of `rpc`.
 * Destructuring a name a CommonJS module does not export is not an error —
 * you get `undefined` — so the bot imported `SorobanRpc` cleanly, passed
 * `node --check`, passed every unit test, and then died on the first line
 * that actually touched RPC:
 *
 *   TypeError: Cannot read properties of undefined (reading 'Server')
 *
 * That is the worst shape of failure for a reference example: it happens
 * after a user has followed the README, installed dependencies, and filled
 * in a real secret key, and it points at a symbol rather than at the rename
 * that caused it.
 *
 * These tests fail against the pre-fix bot and pass after it, and are the
 * layer the existing suite was missing: every other test here exercises pure
 * helpers, which is why 123 of them passed while the bot could not start.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { rpc } = require("@stellar/stellar-sdk");
const { createServer } = require("../index.js");

describe("Soroban RPC namespace", () => {
  it("is exported by the installed @stellar/stellar-sdk", () => {
    // Guards the rename directly: if a future major renames or drops `rpc`,
    // this is the assertion that says so, in one line, before anything else
    // has a chance to fail confusingly.
    assert.ok(
      rpc,
      "@stellar/stellar-sdk no longer exports `rpc` — check whether the RPC namespace was renamed again"
    );
  });

  it("provides every RPC member the bot calls", () => {
    // Named individually rather than smoke-tested through a live call, so a
    // removal is reported as the specific missing member.
    assert.strictEqual(typeof rpc.Server, "function", "rpc.Server");
    assert.strictEqual(typeof rpc.assembleTransaction, "function", "rpc.assembleTransaction");
    assert.strictEqual(typeof rpc.Api.isSimulationError, "function", "rpc.Api.isSimulationError");
    assert.strictEqual(
      typeof rpc.Api.GetTransactionStatus.SUCCESS,
      "string",
      "rpc.Api.GetTransactionStatus.SUCCESS"
    );
    assert.strictEqual(
      typeof rpc.Api.GetTransactionStatus.NOT_FOUND,
      "string",
      "rpc.Api.GetTransactionStatus.NOT_FOUND"
    );
  });
});

describe("createServer", () => {
  // Constructing a server performs no network I/O, so these run offline and
  // are safe in CI.
  const RPC_URL = "https://soroban-testnet.stellar.org";

  it("constructs a server instead of throwing on an undefined namespace", () => {
    // The direct regression: this threw
    // "Cannot read properties of undefined (reading 'Server')" before the fix.
    assert.doesNotThrow(() => createServer(RPC_URL));
  });

  it("returns a client exposing the methods the bot drives it with", () => {
    const server = createServer(RPC_URL);

    for (const method of [
      "getAccount",
      "getContractData",
      "getEvents",
      "getHealth",
      "getLatestLedger",
      "getTransaction",
      "sendTransaction",
      "simulateTransaction",
    ]) {
      assert.strictEqual(
        typeof server[method],
        "function",
        `server.${method} is missing — the bot calls it`
      );
    }
  });

  it("refuses plaintext endpoints", () => {
    // A keeper signs transactions with a secret key, so allowing http would
    // put that traffic on the wire in the clear. The factory hard-codes
    // allowHttp: false precisely so no call site can opt out of that.
    assert.throws(() => createServer("http://insecure.example.com"), /http/i);
  });
});
