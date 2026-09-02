import { Address, Keypair, Networks, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { keypairAuthSigner, signAuthEntries } from "../src/core/auth.js";
import { KeeperContractError, KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { CONTRACT_ID, testClient } from "./support/client.js";

// Defined here rather than in ./support/client.ts so this file does not collide
// with the sibling single-auth admin PR (#230), which edits that file.
const ADMIN_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const ADMIN = ADMIN_KEYPAIR.publicKey();
const NEW_ADMIN_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));
const NEW_ADMIN = NEW_ADMIN_KEYPAIR.publicKey();

const WASM_HASH = new Uint8Array(32).fill(7);

function adminClient(rpcOptions: Record<string, unknown> = {}) {
  return testClient(rpcOptions, { signer: keypairSigner(ADMIN_KEYPAIR) });
}

describe("client.transferAdmin", () => {
  const bothRequired = { authRequiredBy: { transfer_admin: [ADMIN, NEW_ADMIN] } };

  it("signs both required auth entries and submits", async () => {
    const { client, rpc } = adminClient(bothRequired);

    // authorizeEntry verifies each signature against the entry's own address
    // and throws if it does not match, so reaching submission is proof both
    // entries were signed correctly -- not merely that they were touched.
    await client.transferAdmin({
      currentAdmin: ADMIN,
      newAdmin: NEW_ADMIN,
      authSigners: [keypairAuthSigner(ADMIN_KEYPAIR), keypairAuthSigner(NEW_ADMIN_KEYPAIR)],
    });

    expect(rpc.onlyCall.method).toBe("transfer_admin");
    expect(rpc.onlyCall.args).toEqual([ADMIN, NEW_ADMIN]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("refuses before submission when the incoming admin has no signer", async () => {
    const { client, rpc } = adminClient(bothRequired);

    const rejection = await client
      .transferAdmin({
        currentAdmin: ADMIN,
        newAdmin: NEW_ADMIN,
        // Only the current admin -- the mistake that would otherwise cost a fee
        // on a transaction failing require_auth for an invisible reason.
        authSigners: [keypairAuthSigner(ADMIN_KEYPAIR)],
      })
      .catch((error: unknown) => error);

    expect((rejection as Error).message).toContain(NEW_ADMIN);
    expect((rejection as Error).message).toMatch(/no signer for that address/);
    expect(rpc.submitted).toHaveLength(0);
  });

  it("still submits when simulation requires only the source account", async () => {
    const { client, rpc } = adminClient();

    await client.transferAdmin({
      currentAdmin: ADMIN,
      newAdmin: NEW_ADMIN,
      authSigners: [keypairAuthSigner(ADMIN_KEYPAIR)],
    });

    expect(rpc.submitted).toHaveLength(1);
  });
});

describe("signAuthEntries", () => {
  it("leaves a source-account entry untouched", async () => {
    // Satisfied by the envelope signature the client already applies; signing
    // it separately would be wrong, not merely redundant.
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(CONTRACT_ID).toScAddress(),
            functionName: "transfer_admin",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });

    const signed = await signAuthEntries([entry], [], 1_000, Networks.TESTNET, "transfer_admin");

    expect(signed).toHaveLength(1);
    expect(signed[0]?.toXDR().equals(entry.toXDR())).toBe(true);
  });

  it("needs no signers at all when nothing requires an address", async () => {
    await expect(
      signAuthEntries([], [], 1_000, Networks.TESTNET, "transfer_admin"),
    ).resolves.toEqual([]);
  });
});

describe("client.upgrade", () => {
  it("submits a 32-byte wasm hash as bytes", async () => {
    const { client, rpc } = adminClient();

    await client.upgrade({ admin: ADMIN, newWasmHash: WASM_HASH });

    expect(rpc.onlyCall.method).toBe("upgrade");
    expect(rpc.onlyCall.rawArgs[1]?.switch().name).toBe("scvBytes");
    expect(rpc.submitted).toHaveLength(1);
  });

  it("rejects a wrong-length hash locally, naming the argument", async () => {
    for (const length of [31, 33, 0]) {
      const { client, rpc } = adminClient();

      await expect(
        client.upgrade({ admin: ADMIN, newWasmHash: new Uint8Array(length) }),
      ).rejects.toThrow(/newWasmHash must be exactly 32 bytes/);
      // An opaque XDR encoding failure at submission time is what this avoids.
      expect(rpc.calls).toHaveLength(0);
    }
  });
});

describe("client.sweepFees", () => {
  const accrued = { results: { fees_accrued: 1_000_000n } };

  it("sweeps an amount within the accrued balance", async () => {
    const { client, rpc } = adminClient(accrued);

    await client.sweepFees({ admin: ADMIN, treasury: NEW_ADMIN, amount: 250_000n });

    expect(rpc.calls.map((c) => c.method)).toEqual(["fees_accrued", "sweep_fees"]);
    expect(rpc.calls[1]?.args).toEqual([ADMIN, NEW_ADMIN, 250_000n]);
    expect(rpc.calls[1]?.rawArgs[2]?.switch().name).toBe("scvI128");
  });

  it("sweeps exactly the accrued balance -- the inclusive boundary", async () => {
    const { client, rpc } = adminClient(accrued);

    await client.sweepFees({ admin: ADMIN, treasury: NEW_ADMIN, amount: 1_000_000n });

    expect(rpc.calls[1]?.method).toBe("sweep_fees");
    expect(rpc.submitted).toHaveLength(1);
  });

  it("rejects an amount above the accrued balance after one free read", async () => {
    const { client, rpc } = adminClient(accrued);

    const rejection = await client
      .sweepFees({ admin: ADMIN, treasury: NEW_ADMIN, amount: 1_000_001n })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.NoRewardsAvailable)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(true);
    // The read happened; the write never did.
    expect(rpc.calls.map((c) => c.method)).toEqual(["fees_accrued"]);
    expect(rpc.submitted).toHaveLength(0);
  });

  it("rejects a non-positive amount with no network call at all", async () => {
    for (const amount of [0n, -1n]) {
      const { client, rpc } = adminClient(accrued);

      const rejection = await client
        .sweepFees({ admin: ADMIN, treasury: NEW_ADMIN, amount })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.InvalidReward)).toBe(true);
      expect((rejection as KeeperContractError).local).toBe(true);
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("refuses an unsafe number rather than truncating the amount", async () => {
    const { client, rpc } = adminClient(accrued);

    await expect(
      client.sweepFees({
        admin: ADMIN,
        treasury: NEW_ADMIN,
        amount: Number.MAX_SAFE_INTEGER + 2,
      }),
    ).rejects.toThrow(/safe integer range/);
    expect(rpc.calls).toHaveLength(0);
  });

  it("reports the contract's own rejection distinctly from a local one", async () => {
    const { client } = adminClient({
      ...accrued,
      simulationErrors: { sweep_fees: "host invocation failed: Error(Contract, #2)" },
    });

    const rejection = await client
      .sweepFees({ admin: ADMIN, treasury: NEW_ADMIN, amount: 1_000n })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.Unauthorized)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(false);
  });
});
