import { describe, expect, it, vi } from "vitest";

import { ConditionAwareTaskSource } from "./task_source.js";

describe("ConditionAwareTaskSource", () => {
  it("does not submit a candidate while its mock condition is false", async () => {
    const conditionMet = false;
    const isClaimable = vi.fn(async () => conditionMet);
    const source = new ConditionAwareTaskSource(
      { isClaimable },
      { conditionBackoffMs: 5_000, now: () => 1_000 },
    );

    await expect(source.claimableCandidates([{ taskId: 7n }])).resolves.toEqual([]);
    expect(isClaimable).toHaveBeenCalledWith(7n);
  });

  it("deprioritizes a recent ConditionNotMet rejection for the configured period", async () => {
    let now = 10_000;
    const isClaimable = vi.fn(async () => true);
    const source = new ConditionAwareTaskSource(
      { isClaimable },
      { conditionBackoffMs: 30_000, now: () => now },
    );
    source.observeConditionNotMet({
      type: "ConditionNotMet",
      taskId: 9,
      condition: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });

    await expect(source.claimableCandidates([{ taskId: 9n }])).resolves.toEqual([]);
    expect(isClaimable).not.toHaveBeenCalled();

    now += 29_999;
    await expect(source.claimableCandidates([{ taskId: 9n }])).resolves.toEqual([]);
    expect(isClaimable).not.toHaveBeenCalled();

    now += 1;
    await expect(source.claimableCandidates([{ taskId: 9n }])).resolves.toEqual([{ taskId: 9n }]);
    expect(isClaimable).toHaveBeenCalledTimes(1);
  });

  it("resumes a task after a mock condition flips true mid-run", async () => {
    let now = 50_000;
    let conditionMet = false;
    const isClaimable = vi.fn(async () => conditionMet);
    const source = new ConditionAwareTaskSource(
      { isClaimable },
      { conditionBackoffMs: 1_000, now: () => now },
    );

    await expect(source.claimableCandidates([{ taskId: 11n }])).resolves.toEqual([]);
    conditionMet = true;

    now += 999;
    await expect(source.claimableCandidates([{ taskId: 11n }])).resolves.toEqual([]);

    now += 1;
    await expect(source.claimableCandidates([{ taskId: 11n }])).resolves.toEqual([{ taskId: 11n }]);
    expect(isClaimable).toHaveBeenCalledTimes(2);
  });
});
