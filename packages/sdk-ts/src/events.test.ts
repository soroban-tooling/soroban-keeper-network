describe("event decoders", () => {
  it("decodes TaskRegistered");
  it("decodes TaskClaimed");
  it("decodes TaskExecuted");
  it("decodes TaskExpired");
  it("decodes TaskCancelled");
  it("decodes RewardsWithdrawn");
  it("decodes Paused");
  it("decodes FeeUpdated");
  it("decodes AdminTransferred");
  it("decodes RewardIncreased");
  it("decodes DeadlineExtended");
  it("decodes MinRewardUpdated");
  it("decodes FeesSwept");
  it("decodes Initialized");
  it("decodes Upgraded");

  it("returns undefined for an unknown topic pair");
  it("returns undefined for malformed payload");
  it("does not throw for malformed events");
});
