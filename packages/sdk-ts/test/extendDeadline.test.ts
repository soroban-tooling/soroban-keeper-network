import { describe, expect, it } from "vitest";

import { KeeperContractError, KeeperErrorCode, KeeperSdkError, isKeeperError } from "../src/errors.js";
import { OWNER, testClient } from "./support/client.js";

const TASK_ID = 7n;
/** 2030-01-01T00:00:00Z. */
const NEW_DEADLINE_SECONDS = 1_893_456_000n;

describe("client.extendDeadline", () => {
  it("extends a task's deadline", async () => {
    const { client, rpc } = testClient();

    await expect(
      client.extendDeadline({
        owner: OWNER,
        taskId: TASK_ID,
        newDeadline: NEW_DEADLINE_SECONDS,
      }),
    ).resolves.toBeUndefined();

    expect(rpc.onlyCall.method).toBe("extend_deadline");
    expect(rpc.onlyCall.args).toEqual([OWNER, TASK_ID, NEW_DEADLINE_SECONDS]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("accepts a Date, a number, and a bigint interchangeably", async () => {
    const asDate = new Date(Number(NEW_DEADLINE_SECONDS) * 1000);

    for (const newDeadline of [asDate, Number(NEW_DEADLINE_SECONDS), NEW_DEADLINE_SECONDS]) {
      const { client, rpc } = testClient();
      await client.extendDeadline({ owner: OWNER, taskId: TASK_ID, newDeadline });
      expect(rpc.onlyCall.args[2]).toBe(NEW_DEADLINE_SECONDS);
    }
  });

  it("encodes the deadline as u64, matching the contract's parameter type", async () => {
    const { client, rpc } = testClient();
    await client.extendDeadline({
      owner: OWNER,
      taskId: TASK_ID,
      newDeadline: NEW_DEADLINE_SECONDS,
    });

    expect(rpc.onlyCall.rawArgs[2]?.switch().name).toBe("scvU64");
    expect(rpc.onlyCall.rawArgs[1]?.switch().name).toBe("scvU64");
  });

  it("truncates a Date with sub-second precision rather than rounding up", async () => {
    const { client, rpc } = testClient();
    await client.extendDeadline({
      owner: OWNER,
      taskId: TASK_ID,
      // A rounded-up deadline would land later than the caller asked for.
      newDeadline: new Date(Number(NEW_DEADLINE_SECONDS) * 1000 + 999),
    });

    expect(rpc.onlyCall.args[2]).toBe(NEW_DEADLINE_SECONDS);
  });

  it("rejects a millisecond timestamp passed as seconds, before building a transaction", async () => {
    const { client, rpc } = testClient();

    await expect(
      client.extendDeadline({
        owner: OWNER,
        taskId: TASK_ID,
        // Date.now() in place of Math.floor(Date.now() / 1000): a plausible
        // slip that the contract would happily accept as the year 54000.
        newDeadline: Number(NEW_DEADLINE_SECONDS) * 1000,
      }),
    ).rejects.toThrow(KeeperSdkError);

    expect(rpc.calls).toHaveLength(0);
  });

  it("rejects a fractional seconds value rather than silently truncating", async () => {
    const { client } = testClient();

    await expect(
      client.extendDeadline({ owner: OWNER, taskId: TASK_ID, newDeadline: 1_893_456_000.5 }),
    ).rejects.toThrow(/whole number of Unix seconds/);
  });

  it("surfaces the contract's rejection as a typed DeadlinePassed error", async () => {
    const { client } = testClient({
      simulationErrors: {
        extend_deadline: "host invocation failed: Error(Contract, #6)",
      },
    });

    const rejection = await client
      .extendDeadline({ owner: OWNER, taskId: TASK_ID, newDeadline: NEW_DEADLINE_SECONDS })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.DeadlinePassed)).toBe(true);
    expect((rejection as KeeperContractError).codeName).toBe("DeadlinePassed");
    expect((rejection as KeeperContractError).local).toBe(false);
  });

  it("refuses to sign a call the available signer cannot authorize", async () => {
    const { client, rpc } = testClient();
    const otherOwner = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    await expect(
      client.extendDeadline({
        owner: otherOwner,
        taskId: TASK_ID,
        newDeadline: NEW_DEADLINE_SECONDS,
      }),
    ).rejects.toThrow(/must be authorized by/);

    expect(rpc.calls).toHaveLength(0);
  });
});
