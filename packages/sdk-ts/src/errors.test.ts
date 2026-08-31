import { describe, expect, it } from "vitest";

import { decodeKeeperError, KeeperContractError, KeeperErrorCode, TaskNotFoundError } from "./errors";

describe("decodeKeeperError", () => {
  it("extracts a known error code from the standard Soroban diagnostic format", () => {
    expect(decodeKeeperError("HostError: Error(Contract, #4)")).toBe(KeeperErrorCode.TaskNotFound);
  });

  it("extracts the code regardless of surrounding message text", () => {
    expect(
      decodeKeeperError(
        "transaction simulation failed: HostError: Error(Contract, #9)\ncontext: some diagnostic events...",
      ),
    ).toBe(KeeperErrorCode.LockPeriodActive);
  });

  it("returns undefined for a network-level failure with no contract error code", () => {
    expect(decodeKeeperError("fetch failed: ECONNREFUSED")).toBeUndefined();
  });

  it("returns undefined for a host-level trap (Error(WasmVm, ...)) rather than a Result::Err", () => {
    expect(decodeKeeperError("HostError: Error(WasmVm, InvalidAction)")).toBeUndefined();
  });

  it("returns undefined for a numeric code with no matching KeeperErrorCode variant", () => {
    expect(decodeKeeperError("HostError: Error(Contract, #9999)")).toBeUndefined();
  });

  it("returns undefined for undefined, null, or empty input", () => {
    expect(decodeKeeperError(undefined)).toBeUndefined();
    expect(decodeKeeperError(null)).toBeUndefined();
    expect(decodeKeeperError("")).toBeUndefined();
  });

  it("does not match a coincidental '#N' elsewhere in an unrelated error string", () => {
    expect(decodeKeeperError("request #4 timed out after 30s")).toBeUndefined();
  });
});

describe("KeeperContractError", () => {
  it("carries the decoded code and a readable message", () => {
    const err = new KeeperContractError(KeeperErrorCode.ContractPaused);
    expect(err.code).toBe(KeeperErrorCode.ContractPaused);
    expect(err.message).toContain("ContractPaused");
    expect(err.name).toBe("KeeperContractError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("TaskNotFoundError", () => {
  it("is a KeeperContractError with code TaskNotFound and carries the task id", () => {
    const err = new TaskNotFoundError(42);
    expect(err).toBeInstanceOf(KeeperContractError);
    expect(err.code).toBe(KeeperErrorCode.TaskNotFound);
    expect(err.taskId).toBe(42);
    expect(err.message).toBe("Task 42 not found");
    expect(err.name).toBe("TaskNotFoundError");
import {
  KeeperErrorCode,
  decodeKeeperError,
} from "./errors";

describe("KeeperErrorCode", () => {
  it("matches the contract discriminants", () => {
    expect(KeeperErrorCode.AlreadyInitialized).toBe(1);
    expect(KeeperErrorCode.Unauthorized).toBe(2);
    expect(KeeperErrorCode.ContractPaused).toBe(3);
    expect(KeeperErrorCode.TaskNotFound).toBe(4);
    expect(KeeperErrorCode.InvalidTaskStatus).toBe(5);
    expect(KeeperErrorCode.DeadlinePassed).toBe(6);
    expect(KeeperErrorCode.DeadlineNotPassed).toBe(7);
    expect(KeeperErrorCode.InvalidReward).toBe(8);
    expect(KeeperErrorCode.LockPeriodActive).toBe(9);
    expect(KeeperErrorCode.InvalidFeeBps).toBe(10);
    expect(KeeperErrorCode.NotTaskOwner).toBe(11);
    expect(KeeperErrorCode.NotTaskClaimer).toBe(12);
    expect(KeeperErrorCode.NoRewardsAvailable).toBe(13);
    expect(KeeperErrorCode.ProofTooLarge).toBe(14);
    expect(KeeperErrorCode.NotInitialized).toBe(15);
    expect(KeeperErrorCode.TtlTooShort).toBe(16);
    expect(KeeperErrorCode.CalldataTooLarge).toBe(17);
    expect(KeeperErrorCode.InvalidTaskParams).toBe(18);
    expect(KeeperErrorCode.ArithmeticOverflow).toBe(19);
    expect(KeeperErrorCode.IncompatibleVerifierInterface).toBe(20);
    expect(KeeperErrorCode.BatchTooLarge).toBe(21);
    expect(KeeperErrorCode.EmptyBatch).toBe(22);
    expect(KeeperErrorCode.BatchRewardCeilingExceeded).toBe(23);
  });

  it("decodes a known contract error", () => {
    expect(
      decodeKeeperError({ errorCode: 4 }),
    ).toBe(KeeperErrorCode.TaskNotFound);
  });

  it("returns undefined for an unknown code", () => {
    expect(
      decodeKeeperError({ errorCode: 999 }),
    ).toBeUndefined();
  });

  it("returns undefined for network errors", () => {
    expect(
      decodeKeeperError(
        new Error("network unavailable"),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for non-contract failures", () => {
    expect(
      decodeKeeperError({
        status: 500,
        message: "RPC unavailable",
      }),
    ).toBeUndefined();
  });
});
