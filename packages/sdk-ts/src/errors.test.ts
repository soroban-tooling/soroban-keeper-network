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
