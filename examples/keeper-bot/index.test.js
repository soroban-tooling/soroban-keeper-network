"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const stellarSdk = require("@stellar/stellar-sdk");

test("stellar SDK v16 exposes the RPC namespace", () => {
  assert.equal(typeof stellarSdk.rpc, "object");
  assert.equal(typeof stellarSdk.rpc.Server, "function");

  // SorobanRpc was removed in v16. The bot must not depend on it.
  assert.equal(stellarSdk.SorobanRpc, undefined);
});

test("createServer uses the v16 rpc namespace", () => {
  const { rpc } = stellarSdk;

  const server = new rpc.Server(
    "https://soroban-testnet.stellar.org",
    {
      allowHttp: false,
    },
  );

  assert.equal(typeof server, "object");
  assert.equal(typeof server.getHealth, "function");
  assert.equal(typeof server.simulateTransaction, "function");
  assert.equal(typeof server.sendTransaction, "function");
  assert.equal(typeof server.getTransaction, "function");
});
