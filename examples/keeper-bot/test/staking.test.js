/**
 * Test suite for checkStake (E06 keeper staking, #429).
 *
 * The deployed contract enforces no minimum stake to claim_task today
 * (docs/STAKING_DESIGN.md §5 — a real decision, not a gap). checkStake's
 * core guarantee under test: it always logs the keeper's current stake
 * (visibility), and only ever deposits anything when the operator has
 * explicitly opted in via autoStakeEnabled AND the keeper has never staked
 * before — it must never top up an existing stake, never exceed a
 * configured ceiling, and never call stake_deposit at all when disabled.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { checkStake } = require("../index.js");

function makeCtx() {
  const logs = [];
  const warnings = [];
  return {
    log: (msg) => logs.push(msg),
    warn: (msg) => warnings.push(msg),
    logs,
    warnings,
  };
}

function makeKeypair(publicKey = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H") {
  return { publicKey: () => publicKey };
}

function makeClient({ stake = 0n, readError, invokeError } = {}) {
  const invokeCalls = [];
  return {
    invokeCalls,
    async read(method) {
      if (readError) throw readError;
      assert.strictEqual(method, "keeper_stake");
      return stake;
    },
    async invoke(params) {
      invokeCalls.push(params);
      if (invokeError) throw invokeError;
      return undefined;
    },
  };
}

const disabledConfig = { autoStakeEnabled: false, autoStakeAmount: 0n, autoStakeCeiling: 0n };

describe("checkStake — visibility (always runs regardless of config)", () => {
  it("logs the current stake even when auto-staking is disabled", async () => {
    const ctx = makeCtx();
    await checkStake(makeClient({ stake: 500_000n }), makeKeypair(), disabledConfig, ctx);
    assert.ok(ctx.logs.some((l) => l.includes("500000")));
  });

  it("never calls stake_deposit when autoStakeEnabled is false, regardless of current stake", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    await checkStake(client, makeKeypair(), disabledConfig, ctx);
    assert.strictEqual(client.invokeCalls.length, 0);
  });

  it("does not throw and warns (does not crash the round) when the read fails", async () => {
    const ctx = makeCtx();
    const client = makeClient({ readError: new Error("rpc timeout") });
    await assert.doesNotReject(() => checkStake(client, makeKeypair(), disabledConfig, ctx));
    assert.ok(ctx.warnings.some((w) => w.includes("rpc timeout")));
  });
});

describe("checkStake — documented no-op path (no minimum enforced on-chain)", () => {
  it("never blocks or gates anything based on stake — a zero stake still just logs, even with auto-stake off", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    await checkStake(client, makeKeypair(), disabledConfig, ctx);
    assert.strictEqual(client.invokeCalls.length, 0);
    assert.ok(ctx.logs.some((l) => l.includes("Current bonded stake: 0")));
  });
});

describe("checkStake — auto-stake, keeper below/at/above the 'has ever staked' boundary", () => {
  // There is no numeric minimum to test a boundary against (§5) — the real
  // boundary this feature has is binary: has the keeper ever staked
  // (stake > 0) or not (stake === 0). These three tests are the direct
  // analog of the issue's requested below/at/above-minimum coverage for
  // that boundary.

  it("below the boundary (stake === 0): auto-stakes when enabled", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    const config = { autoStakeEnabled: true, autoStakeAmount: 100_000n, autoStakeCeiling: 0n };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 1);
    assert.strictEqual(client.invokeCalls[0].method, "stake_deposit");
    assert.strictEqual(client.invokeCalls[0].source, "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
    assert.ok(ctx.logs.some((l) => l.includes("Auto-stake deposit complete")));
  });

  it("at the boundary (stake === 1, the smallest possible nonzero stake): does not auto-stake again", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 1n });
    const config = { autoStakeEnabled: true, autoStakeAmount: 100_000n, autoStakeCeiling: 0n };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 0);
  });

  it("above the boundary (a keeper who already has substantial stake): does not top up", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 5_000_000n });
    const config = { autoStakeEnabled: true, autoStakeAmount: 100_000n, autoStakeCeiling: 0n };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 0);
  });
});

describe("checkStake — ceiling enforcement", () => {
  it("refuses to deposit when autoStakeAmount exceeds a nonzero autoStakeCeiling", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    const config = {
      autoStakeEnabled: true,
      autoStakeAmount: 500_000n,
      autoStakeCeiling: 100_000n,
    };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 0);
    assert.ok(ctx.warnings.some((w) => w.includes("exceeds AUTO_STAKE_CEILING")));
  });

  it("deposits when autoStakeAmount is exactly at the ceiling", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    const config = {
      autoStakeEnabled: true,
      autoStakeAmount: 100_000n,
      autoStakeCeiling: 100_000n,
    };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 1);
  });

  it("a ceiling of 0 means no ceiling is enforced", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    const config = {
      autoStakeEnabled: true,
      autoStakeAmount: 999_999_999n,
      autoStakeCeiling: 0n,
    };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 1);
  });
});

describe("checkStake — invalid-input / misconfiguration paths", () => {
  it("warns and does not deposit when autoStakeEnabled=true but autoStakeAmount is unset (0)", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n });
    const config = { autoStakeEnabled: true, autoStakeAmount: 0n, autoStakeCeiling: 0n };

    await checkStake(client, makeKeypair(), config, ctx);

    assert.strictEqual(client.invokeCalls.length, 0);
    assert.ok(ctx.warnings.some((w) => w.includes("AUTO_STAKE_AMOUNT is unset")));
  });

  it("warns (does not throw) and does not crash the round when stake_deposit itself fails", async () => {
    const ctx = makeCtx();
    const client = makeClient({ stake: 0n, invokeError: new Error("insufficient balance") });
    const config = { autoStakeEnabled: true, autoStakeAmount: 100_000n, autoStakeCeiling: 0n };

    await assert.doesNotReject(() => checkStake(client, makeKeypair(), config, ctx));

    assert.ok(ctx.warnings.some((w) => w.includes("insufficient balance")));
  });
});
