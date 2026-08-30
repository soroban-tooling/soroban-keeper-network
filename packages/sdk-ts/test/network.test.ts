import { describe, it } from "node:test";
import assert from "node:assert";
import { NETWORK_PRESETS, NETWORK_NAMES, isNetworkName } from "../src/network.js";

describe("NETWORK_PRESETS", () => {
  it("has an entry for testnet, futurenet, and mainnet", () => {
    assert.deepStrictEqual(NETWORK_NAMES.slice().sort(), [
      "futurenet",
      "mainnet",
      "testnet",
    ]);
  });

  it("matches the RPC URLs the keeper-bot's own NETWORK_CONFIG used", () => {
    assert.strictEqual(
      NETWORK_PRESETS.testnet.rpcUrl,
      "https://soroban-testnet.stellar.org",
    );
    assert.strictEqual(
      NETWORK_PRESETS.futurenet.rpcUrl,
      "https://rpc-futurenet.stellar.org",
    );
    assert.strictEqual(
      NETWORK_PRESETS.mainnet.rpcUrl,
      "https://mainnet.sorobanrpc.com",
    );
  });

  it("gives each preset a non-empty network passphrase", () => {
    for (const name of NETWORK_NAMES) {
      assert.ok(NETWORK_PRESETS[name].networkPassphrase.length > 0);
    }
  });
});

describe("isNetworkName", () => {
  it("accepts each of the three preset names", () => {
    assert.strictEqual(isNetworkName("testnet"), true);
    assert.strictEqual(isNetworkName("futurenet"), true);
    assert.strictEqual(isNetworkName("mainnet"), true);
  });

  it("rejects an unknown network name", () => {
    assert.strictEqual(isNetworkName("devnet"), false);
    assert.strictEqual(isNetworkName(""), false);
  });
});
