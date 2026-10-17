import { describe, it, expect, vi } from "vitest";
import { Cli, isOpenProposal } from "../src/cli.js";

describe("isOpenProposal", () => {
  it("treats undefined and null as open", () => {
    expect(isOpenProposal(undefined)).toBe(true);
    expect(isOpenProposal(null as unknown as string)).toBe(true);
  });

  it("identifies active and pending status numbers as open", () => {
    expect(isOpenProposal(0)).toBe(true); // Pending
    expect(isOpenProposal(1)).toBe(true); // Active
  });

  it("identifies non-active status numbers as closed", () => {
    expect(isOpenProposal(2)).toBe(false); // Defeated
    expect(isOpenProposal(3)).toBe(false); // Succeeded
    expect(isOpenProposal(4)).toBe(false); // Queued
    expect(isOpenProposal(5)).toBe(false); // Executed
    expect(isOpenProposal(6)).toBe(false); // Cancelled
  });

  it("identifies status strings case-insensitively", () => {
    expect(isOpenProposal("active")).toBe(true);
    expect(isOpenProposal("Active")).toBe(true);
    expect(isOpenProposal("open")).toBe(true);
    expect(isOpenProposal("Pending")).toBe(true);
    expect(isOpenProposal("executed")).toBe(false);
    expect(isOpenProposal("Defeated")).toBe(false);
  });
});

describe("Cli - inspectKeeper", () => {
  it("logs keeper reputation", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = {
      keeperReputation: vi.fn().mockResolvedValue(100),
    };

    await cli.inspectKeeper(client, "G_KEEPER_1");
    expect(client.keeperReputation).toHaveBeenCalledWith("G_KEEPER_1");
    expect(logSpy).toHaveBeenCalledWith("Keeper reputation: 100");
    logSpy.mockRestore();
  });

  it("warns when reputation is near eligibility floor", async () => {
    const cli = new Cli();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      keeperReputation: vi.fn().mockResolvedValue(55),
    };

    await cli.inspectKeeper(client, "G_KEEPER_1", 50);
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: Reputation (55) is near or below the eligibility floor (50).",
    );
    warnSpy.mockRestore();
  });
});

describe("Cli - listOpenProposals and inspectProposals", () => {
  const operatorAddr = "G_OPERATOR_CONFIGURED_ADDR";

  it("handles client with getOpenProposals and hasVoted method", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockProposals = [
      {
        id: 1n,
        proposer: "G_PROPOSER_1",
        action: { type: "SetFeeBps", newBps: 250 },
        eta: 1000n,
        status: 1, // Active
      },
      {
        id: 2n,
        proposer: "G_PROPOSER_2",
        action: { type: "Pause" },
        eta: 2000n,
        status: "Active",
      },
    ];

    const client = {
      getOpenProposals: vi.fn().mockResolvedValue(mockProposals),
      hasVoted: vi.fn().mockImplementation((id: bigint, addr: string) => {
        if (id === 1n && addr === operatorAddr) return true;
        return false;
      }),
      // Guard: voting methods should NEVER be invoked
      vote: vi.fn(),
      castVote: vi.fn(),
    };

    const summaries = await cli.listOpenProposals(client, operatorAddr);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual({
      id: 1n,
      proposer: "G_PROPOSER_1",
      action: { type: "SetFeeBps", newBps: 250 },
      eta: 1000n,
      status: 1,
      hasVoted: true,
      vote: undefined,
    });
    expect(summaries[1]).toEqual({
      id: 2n,
      proposer: "G_PROPOSER_2",
      action: { type: "Pause" },
      eta: 2000n,
      status: "Active",
      hasVoted: false,
      vote: undefined,
    });

    // Verify read-only visibility (bot never votes automatically)
    expect(client.vote).not.toHaveBeenCalled();
    expect(client.castVote).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("filters out non-open proposals from getProposals", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const allProposals = [
      { id: 10n, status: 1, action: "ActiveAction", votes: new Map([[operatorAddr, 0]]) },
      { id: 11n, status: 5, action: "ExecutedAction" }, // Executed
      { id: 12n, status: 2, action: "DefeatedAction" }, // Defeated
      { id: 13n, status: "Active", action: "OpenAction", votes: new Map() },
    ];

    const client = {
      getProposals: vi.fn().mockResolvedValue(allProposals),
    };

    const summaries = await cli.listOpenProposals(client, operatorAddr);

    expect(summaries).toHaveLength(2);
    expect(summaries[0].id).toBe(10n);
    expect(summaries[0].hasVoted).toBe(true);
    expect(summaries[1].id).toBe(13n);
    expect(summaries[1].hasVoted).toBe(false);

    logSpy.mockRestore();
  });

  it("handles proposalCount and getProposal sequential lookups with getVote", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const client = {
      proposalCount: vi.fn().mockResolvedValue(2),
      getProposal: vi.fn().mockImplementation((id: number) => {
        if (id === 1) return Promise.resolve({ id: 1, status: 1, action: "Task1" });
        if (id === 2) return Promise.resolve({ id: 2, status: 5, action: "Task2" }); // closed
        return Promise.resolve(null);
      }),
      getVote: vi.fn().mockImplementation((id: number, addr: string) => {
        if (id === 1 && addr === operatorAddr) return Promise.resolve({ support: 0 });
        throw new Error("No vote found");
      }),
    };

    const summaries = await cli.listOpenProposals(client, operatorAddr);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(1);
    expect(summaries[0].hasVoted).toBe(true);
    expect(summaries[0].vote).toEqual({ support: 0 });

    logSpy.mockRestore();
  });

  it("handles nested governance client and proposals Map", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const proposalsMap = new Map();
    proposalsMap.set(100n, {
      id: 100n,
      status: 1,
      action: { type: "SetReputationFloor", floorBps: 500 },
      voters: [operatorAddr],
    });

    const rootClient = {
      governance: {
        proposals: proposalsMap,
      },
    };

    const summaries = await cli.inspectProposals(rootClient, operatorAddr);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(100n);
    expect(summaries[0].hasVoted).toBe(true);

    logSpy.mockRestore();
  });

  it("reports correctly when no open proposals exist", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const client = {
      listProposals: vi.fn().mockResolvedValue([]),
    };

    const summaries = await cli.listOpenProposals(client, operatorAddr);

    expect(summaries).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith("=== Open Governance Proposals (0) ===");
    expect(logSpy).toHaveBeenCalledWith("No open proposals found.");

    logSpy.mockRestore();
  });

  it("works when operatorAddress is omitted (unconfigured operator address)", async () => {
    const cli = new Cli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const client = {
      getOpenProposals: vi.fn().mockResolvedValue([
        { id: 1, status: "Active", proposer: "G_PROPOSER" },
      ]),
    };

    const summaries = await cli.listOpenProposals(client);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].hasVoted).toBe(false);
    expect(logSpy).toHaveBeenCalledWith("  Operator Voted: Unknown (no operator address provided)");

    logSpy.mockRestore();
  });
});
