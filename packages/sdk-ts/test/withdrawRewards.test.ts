import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperContractError, KeeperErrorCode, KeeperRpcError, isKeeperError } from "../src/errors.js";
import { KEEPER, KEEPER_KEYPAIR, testClient } from "./support/client.js";

/** Larger than Number.MAX_SAFE_INTEGER, which is the whole point of bigint. */
const HUGE_BALANCE = 9_007_199_254_740_993n;

function keeperClient(rpcOptions = {}) {
  return testClient(rpcOptions, { signer: keypairSigner(KEEPER_KEYPAIR) });
}

describe("client.withdrawRewards", () => {
  it("returns the withdrawn amount the contract reports", async () => {
    const { client, rpc } = keeperClient({ results: { withdraw_rewards: 12_500_000n } });

    const withdrawn = await client.withdrawRewards({ keeper: KEEPER });

    expect(withdrawn).toBe(12_500_000n);
    expect(typeof withdrawn).toBe("bigint");
    expect(rpc.onlyCall.method).toBe("withdraw_rewards");
    expect(rpc.onlyCall.args).toEqual([KEEPER]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("returns an i128 beyond Number.MAX_SAFE_INTEGER without losing precision", async () => {
    const { client } = keeperClient({ results: { withdraw_rewards: HUGE_BALANCE } });

    const withdrawn = await client.withdrawRewards({ keeper: KEEPER });

    expect(withdrawn).toBe(HUGE_BALANCE);
    expect(withdrawn.toString()).toBe("9007199254740993");
    // What a `number` return type would have silently handed back instead.
    expect(Number(withdrawn).toString()).toBe("9007199254740992");
  });

  it("rejects NoRewardsAvailable as a typed code, not a message to match on", async () => {
    const { client } = keeperClient({
      simulationErrors: { withdraw_rewards: "host invocation failed: Error(Contract, #13)" },
    });

    const rejection = await client
      .withdrawRewards({ keeper: KEEPER })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.NoRewardsAvailable)).toBe(true);
    expect((rejection as KeeperContractError).code).toBe(13);
    expect((rejection as KeeperContractError).codeName).toBe("NoRewardsAvailable");
  });

  it("still rejects other contract errors distinctly", async () => {
    const { client } = keeperClient({
      simulationErrors: { withdraw_rewards: "host invocation failed: Error(Contract, #15)" },
    });

    const rejection = await client
      .withdrawRewards({ keeper: KEEPER })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.NotInitialized)).toBe(true);
    expect(isKeeperError(rejection, KeeperErrorCode.NoRewardsAvailable)).toBe(false);
  });

  it("reports an RPC failure separately from a contract rejection", async () => {
    const { client } = keeperClient({
      simulationErrors: { withdraw_rewards: "503 Service Unavailable" },
    });

    await expect(client.withdrawRewards({ keeper: KEEPER })).rejects.toBeInstanceOf(
      KeeperRpcError,
    );
  });

  it("needs a signer that can authorize the withdrawing keeper", async () => {
    // The default client signs as OWNER, not KEEPER.
    const { client, rpc } = testClient();

    await expect(client.withdrawRewards({ keeper: KEEPER })).rejects.toThrow(
      /must be authorized by/,
    );
    expect(rpc.calls).toHaveLength(0);
  });
});

describe("client.tryWithdrawRewards", () => {
  it("resolves to 0n when there is nothing to withdraw", async () => {
    const { client } = keeperClient({
      simulationErrors: { withdraw_rewards: "host invocation failed: Error(Contract, #13)" },
    });

    // A bot withdrawing on a timer hits this as its steady state, not as an
    // incident worth logging.
    await expect(client.tryWithdrawRewards({ keeper: KEEPER })).resolves.toBe(0n);
  });

  it("returns the amount on a successful withdrawal", async () => {
    const { client } = keeperClient({ results: { withdraw_rewards: 42n } });

    await expect(client.tryWithdrawRewards({ keeper: KEEPER })).resolves.toBe(42n);
  });

  it("does not swallow any other contract error", async () => {
    const { client } = keeperClient({
      simulationErrors: { withdraw_rewards: "host invocation failed: Error(Contract, #3)" },
    });

    await expect(client.tryWithdrawRewards({ keeper: KEEPER })).rejects.toMatchObject({
      code: KeeperErrorCode.ContractPaused,
    });
  });
});
