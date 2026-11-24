import { afterEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { KeeperBotV2 } from "../src/index";
import { validateConfig } from "../src/config";
import { MetricsCollector, startMetricsServer, ReadinessChecker, ReadinessResult } from "../src/metrics";

const SECRET_KEY = "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function startServer(readiness?: ReadinessChecker): Promise<string> {
  server = startMetricsServer(new MetricsCollector(), 0, readiness);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a port");
  return `http://127.0.0.1:${address.port}`;
}

function makeBot(databaseUrl?: string): KeeperBotV2 {
  const config = validateConfig({
    NETWORK: "testnet",
    REGISTRY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    KEEPER_SECRET_KEY: SECRET_KEY,
    DATABASE_URL: databaseUrl,
    METRICS_ENABLED: "false",
  });
  return new KeeperBotV2(config);
}

function setRpcHealth(bot: KeeperBotV2, health: () => Promise<unknown>): void {
  (bot as unknown as { rpcServer: { getHealth: () => Promise<unknown> } }).rpcServer = { getHealth: health };
}

function setDatabase(bot: KeeperBotV2, query: () => Promise<unknown>): void {
  (bot as unknown as { dbClient?: { query: () => Promise<unknown> } }).dbClient = { query };
}

async function check(bot: KeeperBotV2): Promise<ReadinessResult> {
  return (bot as unknown as { checkReadiness: () => Promise<ReadinessResult> }).checkReadiness();
}

describe("metrics server probes", () => {
  it("serves /healthz from process state even while not ready", async () => {
    const base = await startServer(async () => ({ ready: false, reasons: ["RPC down"] }));
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 503 with reasons while a dependency is unreachable", async () => {
    const base = await startServer(async () => ({ ready: false, reasons: ["RPC down", "database down"] }));
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      reasons: ["RPC down", "database down"],
    });
  });

  it("recovers to 200 on a later probe after dependencies return", async () => {
    let healthy = false;
    const base = await startServer(async () => ({
      ready: healthy,
      reasons: healthy ? [] : ["RPC down"],
    }));

    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    healthy = true;
    const recovered = await fetch(`${base}/readyz`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: "ready" });
  });

  it("contains a throwing readiness checker instead of crashing the server", async () => {
    const base = await startServer(async () => {
      throw new Error("checker exploded");
    });
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", reasons: ["checker exploded"] });
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });

  it("still exposes the Prometheus endpoint", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("soroban_keeper_tasks_evaluated_total");
  });
});

describe("RPC_URL configuration", () => {
  const baseEnv = () => ({
    NETWORK: "testnet",
    REGISTRY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    KEEPER_SECRET_KEY: SECRET_KEY,
    METRICS_ENABLED: "false",
  });

  it("defaults to the network preset when unset", () => {
    expect(validateConfig(baseEnv()).rpcUrl).toBeUndefined();
  });

  it("accepts an explicit http endpoint", () => {
    expect(validateConfig({ ...baseEnv(), RPC_URL: "https://rpc.example.org/" }).rpcUrl).toBe(
      "https://rpc.example.org/",
    );
  });

  it("rejects a non-http endpoint", () => {
    expect(() => validateConfig({ ...baseEnv(), RPC_URL: "ftp://rpc.example.org" })).toThrow(/RPC_URL/);
  });
});

describe("KeeperBotV2 readiness", () => {
  it("is ready when RPC answers and no database is configured", async () => {
    const bot = makeBot();
    setRpcHealth(bot, async () => ({ status: "healthy" }));
    expect(await check(bot)).toEqual({ ready: true, reasons: [] });
  });

  it("fails when RPC is unreachable", async () => {
    const bot = makeBot();
    setRpcHealth(bot, async () => {
      throw new Error("connection refused");
    });
    const result = await check(bot);
    expect(result.ready).toBe(false);
    expect(result.reasons[0]).toContain("RPC unreachable: connection refused");
  });

  it("fails when the configured database cannot answer a query", async () => {
    const bot = makeBot("postgresql://user:pass@localhost:5432/keeper");
    setRpcHealth(bot, async () => ({ status: "healthy" }));
    setDatabase(bot, async () => {
      throw new Error("database closed");
    });
    const result = await check(bot);
    expect(result.ready).toBe(false);
    expect(result.reasons[0]).toContain("database unreachable: database closed");
  });

  it("reports a timeout when RPC health never settles", async () => {
    const bot = makeBot();
    setRpcHealth(bot, () => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = check(bot);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(result.ready).toBe(false);
      expect(result.reasons[0]).toContain("RPC health check timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when RPC and database return", async () => {
    const bot = makeBot("postgresql://user:pass@localhost:5432/keeper");
    let rpcUp = false;
    let dbUp = false;
    setRpcHealth(bot, async () => {
      if (!rpcUp) throw new Error("RPC down");
      return { status: "healthy" };
    });
    setDatabase(bot, async () => {
      if (!dbUp) throw new Error("DB down");
      return { rows: [] };
    });

    expect((await check(bot)).reasons).toHaveLength(2);
    rpcUp = true;
    expect((await check(bot)).reasons).toEqual(["database unreachable: DB down"]);
    dbUp = true;
    expect(await check(bot)).toEqual({ ready: true, reasons: [] });
  });
});
