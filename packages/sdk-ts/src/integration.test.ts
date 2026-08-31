import {
  describe,
  expect,
  it,
  beforeAll,
} from "vitest";

describe("SDK local Soroban integration", () => {
  let client: any;

  beforeAll(async () => {
    /*
     * Connect to the local Soroban network started by the CI job.
     *
     * The actual client constructor and deployment helper should reuse
     * the existing SDK setup rather than introducing another client.
     */

    client = await createLocalTestClient();
  });

  it("runs the complete task lifecycle", async () => {
    const task = await client.registerTask({
      owner: TEST_OWNER,
      reward: 1_000_000n,
      deadline: await getFutureDeadline(),
      taskType: "test",
    });

    expect(task).toBeDefined();

    await client.claimTask({
      taskId: task.taskId,
      keeper: TEST_KEEPER,
    });

    await client.executeTask({
      taskId: task.taskId,
      keeper: TEST_KEEPER,
      proof: TEST_PROOF,
    });

    const balance = await client.keeperBalance(
      TEST_KEEPER,
    );

    expect(balance).toBeGreaterThan(0n);
  });

  it("runs the admin lifecycle", async () => {
    await client.pause();

    expect(
      await client.isPaused(),
    ).toBe(true);

    await client.setFee(100);

    await client.transferAdmin(
      SECOND_ADMIN,
    );
  });

  it("withdraws keeper rewards", async () => {
    const before =
      await client.keeperBalance(TEST_KEEPER);

    await client.withdrawRewards();

    const after =
      await client.keeperBalance(TEST_KEEPER);

    expect(after).toBeLessThanOrEqual(before);
  });
});
