import assert from "node:assert/strict";
import test from "node:test";
import { TaskStatus } from "@soroban-keeper-network/sdk";
import { createCanary } from "../src/canary.mjs";

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function fakeClient({ statusSequence = [TaskStatus.Pending, TaskStatus.Executed], failRegister = false } = {}) {
  let index = 0;
  return {
    registrations: [],
    async registerTask(params) {
      if (failRegister) throw new Error("registration rejected");
      this.registrations.push(params);
      return 42n;
    },
    async getTask(taskId) {
      assert.equal(taskId, 42n);
      const status = statusSequence[Math.min(index, statusSequence.length - 1)];
      index += 1;
      return { status };
    },
  };
}

test("records time to execution when the canary task runs", async () => {
  const clock = fakeClock();
  const samples = [];
  const client = fakeClient();
  const canary = createCanary({
    client,
    owner: "GFAKE",
    clock,
    targetMs: 10_000,
    pollMs: 1_000,
    onSamples: (value) => samples.push(value),
  });

  const result = await canary.round();

  assert.equal(client.registrations.length, 1);
  assert.equal(client.registrations[0].owner, "GFAKE");
  assert.equal(client.registrations[0].taskType, 5);
  assert.equal(canary.getStats().executions, 1);
  assert.equal(canary.getStats().missed, 0);
  assert.equal(result.find((s) => s.name === "soroban_canary_executions_total").value, 1);
  assert.equal(Number(result.find((s) => s.name === "soroban_canary_time_to_execution_seconds").value), 1);
  assert.equal(samples.length, 1);
});

test("increments missed executions when the target is exceeded", async () => {
  const clock = fakeClock();
  const canary = createCanary({
    client: fakeClient({ statusSequence: [TaskStatus.Pending] }),
    owner: "GFAKE",
    clock,
    targetMs: 3_000,
    pollMs: 1_000,
  });

  await canary.round();
  await canary.round();

  assert.equal(canary.getStats().registered, 2);
  assert.equal(canary.getStats().executions, 0);
  assert.equal(canary.getStats().missed, 2);
});

test("registration failure is contained and reported as a miss", async () => {
  const errors = [];
  const canary = createCanary({
    client: fakeClient({ failRegister: true }),
    owner: "GFAKE",
    clock: fakeClock(),
    onError: (error) => errors.push(error.message),
  });

  const result = await canary.round();

  assert.equal(result, undefined);
  assert.deepEqual(errors, ["registration rejected"]);
  assert.equal(canary.getStats().missed, 1);
});

test("rendered canary metrics use the shared catalog names", () => {
  const canary = createCanary({ client: fakeClient(), owner: "GFAKE", clock: fakeClock() });
  const text = canary.render();
  assert.match(text, /# TYPE soroban_canary_executions_total counter/);
  assert.match(text, /# TYPE soroban_canary_missed_executions_total counter/);
  assert.match(text, /task_id="testnet-canary"/);
});
