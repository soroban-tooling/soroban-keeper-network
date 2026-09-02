import { describe, expect, it } from "vitest";

import { KeeperRegistryClient } from "./client";

// A real, valid Soroban contract address StrKey (StrKey.encodeContract of
// 32 zero bytes, confirmed via StrKey.isValidContract before trusting it —
// a hand-typed string of the right length is not automatically a valid
// checksum), used throughout so constructor validation exercises real
// StrKey decoding rather than a string that merely looks plausible.
const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_RPC_URL = "https://soroban-testnet.stellar.org";
const VALID_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

describe("KeeperRegistryClient constructor validation", () => {
  it("constructs successfully with valid config", () => {
    expect(
      () =>
        new KeeperRegistryClient({
          contractId: VALID_CONTRACT_ID,
          rpcUrl: VALID_RPC_URL,
          networkPassphrase: VALID_NETWORK_PASSPHRASE,
        }),
    ).not.toThrow();
  });

  it("rejects a malformed contract address with a clear error rather than deferring to a later opaque RPC failure", () => {
    expect(
      () =>
        new KeeperRegistryClient({
          contractId: "not-a-real-contract-address",
          rpcUrl: VALID_RPC_URL,
          networkPassphrase: VALID_NETWORK_PASSPHRASE,
        }),
    ).toThrow(/not a valid Soroban contract address/);
  });

  it("rejects an account address (G...) passed where a contract address (C...) is expected", () => {
    // A common mistake — StrKey.isValidContract correctly distinguishes
    // these since they carry different version bytes, even though both are
    // 56-character base32 strings.
    expect(
      () =>
        new KeeperRegistryClient({
          contractId: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
          rpcUrl: VALID_RPC_URL,
          networkPassphrase: VALID_NETWORK_PASSPHRASE,
        }),
    ).toThrow(/not a valid Soroban contract address/);
  });

  it("rejects a non-URL rpcUrl", () => {
    expect(
      () =>
        new KeeperRegistryClient({
          contractId: VALID_CONTRACT_ID,
          rpcUrl: "not-a-url",
          networkPassphrase: VALID_NETWORK_PASSPHRASE,
        }),
    ).toThrow(/not a valid RPC URL/);
  });

  it("rejects an empty networkPassphrase", () => {
    expect(
      () =>
        new KeeperRegistryClient({
          contractId: VALID_CONTRACT_ID,
          rpcUrl: VALID_RPC_URL,
          networkPassphrase: "",
        }),
    ).toThrow(/networkPassphrase is required/);
  });
});

describe("KeeperRegistryClient.getTask", () => {
  it("throws a clear, actionable error when no source account is available for simulation", async () => {
    const client = new KeeperRegistryClient({
      contractId: VALID_CONTRACT_ID,
      rpcUrl: VALID_RPC_URL,
      networkPassphrase: VALID_NETWORK_PASSPHRASE,
      // readOnlySourceAccount deliberately omitted
    });
    await expect(client.getTask(1)).rejects.toThrow(/requires a source account/);
  });
});
