import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperContractError, KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { ADMIN, ADMIN_KEYPAIR, KEEPER_KEYPAIR, testClient } from "./support/client.js";

/** Beyond Number.MAX_SAFE_INTEGER, which is why a reward floor is an i128. */
const HUGE_MIN_REWARD = 9_007_199_254_740_993n;

/**
 * Every admin entry point first reads `admin` to tell NotInitialized apart from
 * Unauthorized, so the happy path is configured with a registry that has one.
 */
function adminClient(rpcOptions: Record<string, unknown> = {}) {
  const { results = {}, ...rest } = rpcOptions as { results?: Record<string, unknown> };
  return testClient(
    { results: { admin: ADMIN, ...results }, ...rest },
    { signer: keypairSigner(ADMIN_KEYPAIR) },
  );
}

describe("client.pause / client.unpause", () => {
  it("submits pause authorized by the admin", async () => {
    const { client, rpc } = adminClient();

    await client.pause({ admin: ADMIN });

    // Two calls: the admin probe, then the pause itself.
    expect(rpc.calls.map((c) => c.method)).toEqual(["admin", "pause"]);
    expect(rpc.calls[1]?.args).toEqual([ADMIN]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("submits unpause authorized by the admin", async () => {
    const { client, rpc } = adminClient();

    await client.unpause({ admin: ADMIN });

    expect(rpc.calls.map((c) => c.method)).toEqual(["admin", "unpause"]);
    expect(rpc.calls[1]?.args).toEqual([ADMIN]);
  });

  it("surfaces the contract's Unauthorized when the caller is not the admin", async () => {
    const { client } = adminClient({
      simulationErrors: { pause: "host invocation failed: Error(Contract, #2)" },
    });

    const rejection = await client.pause({ admin: ADMIN }).catch((e: unknown) => e);

    expect(isKeeperError(rejection, KeeperErrorCode.Unauthorized)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(false);
  });
});

describe("admin methods on an uninitialized registry", () => {
  it("rejects NotInitialized instead of the contract's ambiguous Unauthorized", async () => {
    // `admin` returning void is what an uninitialized registry reports.
    const { client, rpc } = adminClient({ results: { admin: undefined } });

    const rejection = await client.pause({ admin: ADMIN }).catch((e: unknown) => e);

    expect(isKeeperError(rejection, KeeperErrorCode.NotInitialized)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(true);
    // The probe ran; the pause never did, so nothing was signed or submitted.
    expect(rpc.calls.map((c) => c.method)).toEqual(["admin"]);
    expect(rpc.submitted).toHaveLength(0);
  });

  it("applies to every single-auth admin entry point", async () => {
    for (const call of [
      (c: ReturnType<typeof adminClient>["client"]) => c.unpause({ admin: ADMIN }),
      (c: ReturnType<typeof adminClient>["client"]) => c.setFeeBps({ admin: ADMIN, newBps: 250 }),
      (c: ReturnType<typeof adminClient>["client"]) =>
        c.setMinReward({ admin: ADMIN, minReward: 1n }),
    ]) {
      const { client } = adminClient({ results: { admin: undefined } });
      const rejection = await call(client).catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.NotInitialized)).toBe(true);
    }
  });
});

describe("client.setFeeBps", () => {
  it("encodes newBps as a u32 and submits it", async () => {
    const { client, rpc } = adminClient();

    await client.setFeeBps({ admin: ADMIN, newBps: 250 });

    expect(rpc.calls[1]?.method).toBe("set_fee_bps");
    expect(rpc.calls[1]?.args).toEqual([ADMIN, 250]);
    // A u32 on the wire, not the i128/u64 the other numeric fields use.
    expect(rpc.calls[1]?.rawArgs[1]?.switch().name).toBe("scvU32");
  });

  it("accepts exactly 10000 -- the contract's inclusive ceiling", async () => {
    const { client, rpc } = adminClient();

    await client.setFeeBps({ admin: ADMIN, newBps: 10_000 });

    expect(rpc.calls[1]?.args).toEqual([ADMIN, 10_000]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("rejects 10001 locally, before any network call", async () => {
    const { client, rpc } = adminClient();

    const rejection = await client
      .setFeeBps({ admin: ADMIN, newBps: 10_001 })
      .catch((e: unknown) => e);

    expect(isKeeperError(rejection, KeeperErrorCode.InvalidFeeBps)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(true);
    // Not even the admin probe ran: the value can never succeed.
    expect(rpc.calls).toHaveLength(0);
    expect(rpc.submitted).toHaveLength(0);
  });

  it("rejects negative and non-integer basis points locally too", async () => {
    for (const newBps of [-1, 1.5, Number.NaN]) {
      const { client, rpc } = adminClient();
      const rejection = await client.setFeeBps({ admin: ADMIN, newBps }).catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.InvalidFeeBps)).toBe(true);
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("reports the same code whether the rejection was local or on-chain", async () => {
    const { client } = adminClient({
      simulationErrors: { set_fee_bps: "host invocation failed: Error(Contract, #10)" },
    });

    const remote = await client.setFeeBps({ admin: ADMIN, newBps: 250 }).catch((e: unknown) => e);

    expect(isKeeperError(remote, KeeperErrorCode.InvalidFeeBps)).toBe(true);
    expect((remote as KeeperContractError).local).toBe(false);
  });
});

describe("client.setMinReward", () => {
  it("encodes the floor as an i128", async () => {
    const { client, rpc } = adminClient();

    await client.setMinReward({ admin: ADMIN, minReward: 5_000_000n });

    expect(rpc.calls[1]?.method).toBe("set_min_reward");
    expect(rpc.calls[1]?.args).toEqual([ADMIN, 5_000_000n]);
    expect(rpc.calls[1]?.rawArgs[1]?.switch().name).toBe("scvI128");
  });

  it("carries a value beyond Number.MAX_SAFE_INTEGER without losing precision", async () => {
    const { client, rpc } = adminClient();

    await client.setMinReward({ admin: ADMIN, minReward: HUGE_MIN_REWARD });

    expect(rpc.calls[1]?.args[1]).toBe(HUGE_MIN_REWARD);
  });

  it("accepts a safe number for callers who have one on hand", async () => {
    const { client, rpc } = adminClient();

    await client.setMinReward({ admin: ADMIN, minReward: 1_000 });

    expect(rpc.calls[1]?.args).toEqual([ADMIN, 1_000n]);
  });

  it("refuses an unsafe number rather than silently truncating it", async () => {
    const { client, rpc } = adminClient();

    await expect(
      client.setMinReward({ admin: ADMIN, minReward: Number.MAX_SAFE_INTEGER + 2 }),
    ).rejects.toThrow(/safe integer range/);
    expect(rpc.calls).toHaveLength(0);
  });
});

describe("admin call authorization", () => {
  it("refuses to sign with a key that is not the admin", async () => {
    const { client, rpc } = testClient(
      { results: { admin: ADMIN } },
      { signer: keypairSigner(KEEPER_KEYPAIR) },
    );

    await expect(client.pause({ admin: ADMIN })).rejects.toThrow(/must be authorized by/);
    expect(rpc.submitted).toHaveLength(0);
  });
});
