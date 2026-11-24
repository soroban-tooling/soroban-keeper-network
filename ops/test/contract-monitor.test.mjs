import assert from "node:assert/strict";
import test from "node:test";
import { collectContractSamples, createContractMonitor } from "../src/contract-monitor.mjs";
import { renderPrometheus } from "../src/metrics.mjs";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function fakeClient(overrides = {}) {
  const replies = {
    is_paused: true,
    fees_accrued: 12_345n,
    task_count: 7,
    version: 4,
    ...overrides,
  };
  return {
    replies,
    read(method) {
      if (!(method in replies)) throw new Error(`unexpected view ${method}`);
      return Promise.resolve(replies[method]);
    },
  };
}

test("collects all five contract state views as bounded metrics", async () => {
  const samples = await collectContractSamples({
    client: fakeClient(),
    server: {},
    contractId: CONTRACT_ID,
    readInstanceTtl: async () => 1_800,
  });

  assert.deepEqual(
    samples.map((sample) => sample.name),
    [
      "soroban_contract_paused",
      "soroban_contract_fees_accrued_stroops",
      "soroban_contract_task_count",
      "soroban_contract_version",
      "soroban_contract_instance_ttl_remaining_seconds",
    ],
  );
  assert.equal(samples[0].value, 1);
  assert.equal(samples[1].value, "12345");
  assert.equal(samples[2].value, 7);
  assert.equal(samples[3].value, 4);
  assert.equal(samples[4].value, 1_800);
  assert.ok(samples.every((sample) => sample.labels.contract_id === CONTRACT_ID));
});

test("map converts paused=false to 0", async () => {
  const samples = await collectContractSamples({
    client: fakeClient({ is_paused: false }),
    server: {},
    contractId: CONTRACT_ID,
    readInstanceTtl: async () => 0,
  });
  assert.equal(samples[0].value, 0);
  assert.equal(samples[4].value, 0);
});

test("a failed poll keeps the last good samples and reports the error", async () => {
  const client = fakeClient();
  let fail = false;
  const errors = [];
  const monitor = createContractMonitor({
    client: {
      read(method) {
        if (fail) throw new Error("RPC down");
        return client.read(method);
      },
    },
    server: {},
    contractId: CONTRACT_ID,
    readInstanceTtl: async () => 900,
    onError: (error) => errors.push(error.message),
  });

  await monitor.poll();
  const before = monitor.render();
  fail = true;
  const result = await monitor.poll();

  assert.equal(result, undefined);
  assert.equal(monitor.render(), before);
  assert.deepEqual(errors, ["RPC down"]);
});

test("rendered exposition declares each family once", async () => {
  const samples = await collectContractSamples({
    client: fakeClient(),
    server: {},
    contractId: CONTRACT_ID,
    readInstanceTtl: async () => 300,
  });
  const text = renderPrometheus(samples);
  assert.match(text, /# HELP soroban_contract_paused Whether the registry is paused \(1\) or not \(0\)\./);
  assert.equal(text.match(/# TYPE soroban_contract_paused/g).length, 1);
  assert.match(text, /soroban_contract_fees_accrued_stroops\{contract_id="CAAAA/);
});
