import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExecutorRegistry,
  dispatchTask,
  type ExecuteContext,
  type KeeperTask,
  type TaskExecutor,
} from "../src/executors/interface.js";
import {
  loadExecutorModules,
  parseExecutorModuleList,
} from "../src/executors/loader.js";
import { ttlExtensionExecutor } from "../src/executors/ttl-extension.js";

const futureDeadline = Math.floor(Date.now() / 1_000) + 60;
const task: KeeperTask = {
  id: 41n,
  taskType: 4,
  calldata: new TextEncoder().encode(
    JSON.stringify({ contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM", extendToLedger: 900_000 }),
  ),
  rewardStroops: 5_000_000n,
  deadlineUnixSeconds: futureDeadline,
};

function context(onExtend?: () => void): ExecuteContext {
  return {
    idempotencyKey: "testnet:registry:keeper:41:ttl-extension:1",
    signal: new AbortController().signal,
    extendContractTtl: async () => {
      onExtend?.();
      return { transactionHash: "abc123", costStroops: 900n };
    },
  };
}

describe("executor plugins", () => {
  it("loads configured modules without editing bot source", async () => {
    const source = `export default {
      name: "configured-plugin",
      version: "1.0.0",
      taskTypes: [5],
      async estimate() { return { expectedCostStroops: 1n, worstCaseCostStroops: 1n, createdAtMs: 1, validUntilMs: 2, idempotent: true }; },
      async execute() { return null; }
    }`;
    const registry = await loadExecutorModules([
      `data:text/javascript,${encodeURIComponent(source)}`,
    ]);

    assert.equal(registry.find(5)?.name, "configured-plugin");
    assert.deepEqual(parseExecutorModuleList("./ttl.js, @org/oracle"), [
      "./ttl.js",
      "@org/oracle",
    ]);
  });

  it("rejects duplicate task type registrations", () => {
    const registry = new ExecutorRegistry();
    registry.register(ttlExtensionExecutor);
    const duplicate: TaskExecutor = {
      ...ttlExtensionExecutor,
      name: "another-ttl",
    };
    assert.throws(() => registry.register(duplicate), /already registered/);
  });

  it("skips unknown task types with a distinct log event", async () => {
    const events: string[] = [];
    const registry = new ExecutorRegistry();
    const result = await dispatchTask(
      { ...task, taskType: 99 },
      registry,
      context(),
      { info: (event) => events.push(event) },
    );

    assert.equal(result, null);
    assert.deepEqual(events, ["task_skipped_no_executor"]);
  });

  it("executes the real TTL extension capability and returns its proof", async () => {
    let extended = false;
    const registry = new ExecutorRegistry();
    registry.register(ttlExtensionExecutor);

    const result = await dispatchTask(
      task,
      registry,
      context(() => {
        extended = true;
      }),
      { info: () => undefined },
    );

    assert.equal(extended, true);
    assert.equal(result?.costStroops, 900n);
    assert.equal(
      new TextDecoder().decode(result?.proof),
      "ttl-extension:abc123",
    );
  });
});
