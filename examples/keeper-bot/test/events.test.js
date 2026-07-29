/**
 * Test suite for fetchPendingTasks()
 *
 * This function queries the Soroban RPC for TaskRegistered events and decodes
 * them into task objects. It must:
 *   - Correctly decode valid events
 *   - Skip malformed events without crashing
 *   - Count malformed events separately
 *   - Continue processing after encountering bad data
 *
 * We use a fake RPC server instead of mocking the Stellar SDK.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { fetchPendingTasks } = require("../index.js");

/**
 * Fake RPC server that implements only the methods the keeper bot needs.
 * This is a hand-written fake, not a mock from a framework.
 */
class FakeRpcServer {
  constructor() {
    this.events = [];
    this.latestLedger = { sequence: 1000, hash: "fake-hash" };
    this.health = { status: "healthy", ledger: 1000 };
  }

  setEvents(events) {
    this.events = events;
  }

  async getEvents({ startLedger, filters, limit }) {
    // Simulate RPC response structure
    return {
      events: this.events,
      latestLedger: this.latestLedger.sequence,
    };
  }

  async getLatestLedger() {
    return this.latestLedger;
  }

  async getHealth() {
    return this.health;
  }

  async getAccount(publicKey) {
    return {
      accountId: publicKey,
      sequence: "1000",
    };
  }

  async simulateTransaction(tx) {
    return {
      results: [],
      cost: { cpuInsns: "1000", memBytes: "1000" },
    };
  }
}

/**
 * Helper to create a valid TaskRegistered event in the format returned by
 * the Soroban RPC.
 */
function createTaskEvent(taskId, reward, deadline) {
  return {
    type: "contract",
    ledger: "1000",
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    id: `0001000000000000-${taskId}`,
    pagingToken: `0001000000000000-${taskId}`,
    inSuccessfulContractCall: true,
    topic: [
      "AAAADwAAAANyZWc=", // "reg"
      "AAAADwAAAAR0YXNr", // "task"
    ],
    value: {
      // Mimic ScVal structure
      value: () => [
        { toU64: () => BigInt(taskId) }, // taskId
        { value: () => "owner-address" }, // owner (not decoded in function)
        { toI128: () => BigInt(reward) }, // reward
        { toU64: () => BigInt(deadline) }, // deadline
      ],
    },
  };
}

describe("fetchPendingTasks", () => {
  describe("valid event decoding", () => {
    it("decodes a single valid event", async () => {
      const server = new FakeRpcServer();
      server.setEvents([createTaskEvent(1, 1000000, 1735689600)]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].taskId, 1n);
      assert.strictEqual(tasks[0].reward, 1000000n);
      assert.strictEqual(tasks[0].deadline, 1735689600n);
    });

    it("decodes multiple valid events", async () => {
      const server = new FakeRpcServer();
      server.setEvents([
        createTaskEvent(1, 1000000, 1735689600),
        createTaskEvent(2, 2000000, 1735776000),
        createTaskEvent(3, 3000000, 1735862400),
      ]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 3);
      assert.strictEqual(tasks[0].taskId, 1n);
      assert.strictEqual(tasks[1].taskId, 2n);
      assert.strictEqual(tasks[2].taskId, 3n);
    });

    it("preserves task details correctly", async () => {
      const server = new FakeRpcServer();
      const reward = 5000000n;
      const deadline = 1735689600n;
      server.setEvents([createTaskEvent(42, reward, deadline)]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks[0].taskId, 42n);
      assert.strictEqual(tasks[0].reward, reward);
      assert.strictEqual(tasks[0].deadline, deadline);
    });
  });

  describe("malformed event handling", () => {
    it("skips event with missing value", async () => {
      const server = new FakeRpcServer();
      const goodEvent = createTaskEvent(1, 1000000, 1735689600);
      const badEvent = {
        ...createTaskEvent(2, 2000000, 1735776000),
        value: null,
      };

      server.setEvents([goodEvent, badEvent]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      // Should only get the good event
      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].taskId, 1n);
    });

    it("skips event with malformed value structure", async () => {
      const server = new FakeRpcServer();
      const goodEvent = createTaskEvent(1, 1000000, 1735689600);
      const badEvent = {
        ...createTaskEvent(2, 2000000, 1735776000),
        value: {
          value: () => {
            throw new Error("Malformed XDR");
          },
        },
      };

      server.setEvents([goodEvent, badEvent]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].taskId, 1n);
    });

    it("continues processing after malformed event", async () => {
      const server = new FakeRpcServer();
      const event1 = createTaskEvent(1, 1000000, 1735689600);
      const badEvent = { ...createTaskEvent(2, 2000000, 1735776000), value: null };
      const event3 = createTaskEvent(3, 3000000, 1735862400);

      server.setEvents([event1, badEvent, event3]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(tasks[0].taskId, 1n);
      assert.strictEqual(tasks[1].taskId, 3n);
    });

    it("handles all events being malformed", async () => {
      const server = new FakeRpcServer();
      server.setEvents([
        { value: null },
        { value: { value: () => [] } },
        { value: { value: () => { throw new Error("bad"); } } },
      ]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 0);
    });
  });

  describe("RPC error handling", () => {
    it("returns empty array when RPC fails", async () => {
      const server = new FakeRpcServer();
      server.getEvents = async () => {
        throw new Error("RPC connection timeout");
      };

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 0);
    });

    it("handles RPC returning no events field", async () => {
      const server = new FakeRpcServer();
      server.getEvents = async () => ({
        latestLedger: 1000,
        // events field missing
      });

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 0);
    });

    it("handles RPC returning undefined", async () => {
      const server = new FakeRpcServer();
      server.getEvents = async () => undefined;

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 0);
    });
  });

  describe("edge cases", () => {
    it("handles empty event list", async () => {
      const server = new FakeRpcServer();
      server.setEvents([]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 0);
    });

    it("handles large task IDs", async () => {
      const server = new FakeRpcServer();
      const largeTaskId = 2n ** 63n - 1n; // Max u64
      server.setEvents([
        {
          ...createTaskEvent(0, 1000000, 1735689600),
          value: {
            value: () => [
              { toU64: () => largeTaskId },
              { value: () => "owner" },
              { toI128: () => 1000000n },
              { toU64: () => 1735689600n },
            ],
          },
        },
      ]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].taskId, largeTaskId);
    });

    it("handles zero values", async () => {
      const server = new FakeRpcServer();
      server.setEvents([createTaskEvent(0, 0, 0)]);

      const tasks = await fetchPendingTasks(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        900
      );

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].taskId, 0n);
      assert.strictEqual(tasks[0].reward, 0n);
      assert.strictEqual(tasks[0].deadline, 0n);
    });
  });
});
