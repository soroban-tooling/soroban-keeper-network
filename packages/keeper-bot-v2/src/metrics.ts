import { createServer, type Server } from "node:http";

import { Counter, Gauge, Registry } from "@prometheus-io/client";

export const SKIP_REASONS = [
  "not_claimable",
  "unprofitable",
  "no_executor",
  "other",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

interface RoundCounts {
  evaluated: number;
  claimed: number;
  executed: number;
  skipped: Record<SkipReason, number>;
}

export class KeeperMetrics {
  readonly registry: Registry;
  readonly #lastRoundEvaluated: Gauge;
  readonly #lastRoundClaimed: Gauge;
  readonly #lastRoundExecuted: Gauge;
  readonly #lastRoundSkipped: Gauge<"reason">;
  readonly #keeperBalance: Gauge;
  readonly #roundDuration: Gauge;
  readonly #rpcErrors: Counter<"type">;

  constructor(registry = new Registry()) {
    this.registry = registry;
    this.#lastRoundEvaluated = new Gauge({
      name: "keeper_last_round_tasks_evaluated",
      help: "Tasks evaluated in the last completed keeper round.",
      registers: [registry],
    });
    this.#lastRoundClaimed = new Gauge({
      name: "keeper_last_round_tasks_claimed",
      help: "Tasks claimed in the last completed keeper round.",
      registers: [registry],
    });
    this.#lastRoundExecuted = new Gauge({
      name: "keeper_last_round_tasks_executed",
      help: "Tasks executed in the last completed keeper round.",
      registers: [registry],
    });
    this.#lastRoundSkipped = new Gauge({
      name: "keeper_last_round_tasks_skipped",
      help: "Tasks skipped in the last completed keeper round by reason.",
      labelNames: ["reason"],
      registers: [registry],
    });
    this.#keeperBalance = new Gauge({
      name: "keeper_balance_stroops",
      help: "Current on-chain keeper reward balance in stroops.",
      registers: [registry],
    });
    this.#roundDuration = new Gauge({
      name: "keeper_last_round_duration_seconds",
      help: "Wall-clock duration of the last completed keeper round.",
      registers: [registry],
    });
    this.#rpcErrors = new Counter({
      name: "keeper_rpc_errors_total",
      help: "RPC errors observed by the keeper, classified by type.",
      labelNames: ["type"],
      registers: [registry],
    });

    for (const reason of SKIP_REASONS) {
      this.#lastRoundSkipped.labels(reason).set(0);
    }
  }

  beginRound(nowNs = process.hrtime.bigint()): RoundMetrics {
    return new RoundMetrics(this, nowNs);
  }

  setKeeperBalance(stroops: bigint): void {
    if (stroops < 0n || stroops > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("keeper balance must fit a non-negative safe integer");
    }
    this.#keeperBalance.set(Number(stroops));
  }

  recordRpcError(type: string): void {
    const normalized = type.trim();
    if (normalized === "") {
      throw new Error("RPC error type must not be empty");
    }
    this.#rpcErrors.labels(normalized).inc();
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  publishRound(counts: Readonly<RoundCounts>, durationSeconds: number): void {
    this.#lastRoundEvaluated.set(counts.evaluated);
    this.#lastRoundClaimed.set(counts.claimed);
    this.#lastRoundExecuted.set(counts.executed);
    for (const reason of SKIP_REASONS) {
      this.#lastRoundSkipped.labels(reason).set(counts.skipped[reason]);
    }
    this.#roundDuration.set(durationSeconds);
  }
}

export class RoundMetrics {
  readonly #owner: KeeperMetrics;
  readonly #startedAtNs: bigint;
  readonly #counts: RoundCounts = {
    evaluated: 0,
    claimed: 0,
    executed: 0,
    skipped: {
      not_claimable: 0,
      unprofitable: 0,
      no_executor: 0,
      other: 0,
    },
  };
  #finished = false;

  constructor(owner: KeeperMetrics, startedAtNs: bigint) {
    this.#owner = owner;
    this.#startedAtNs = startedAtNs;
  }

  evaluated(count = 1): void {
    this.#assertActive();
    this.#counts.evaluated += validateCount(count);
  }

  claimed(count = 1): void {
    this.#assertActive();
    this.#counts.claimed += validateCount(count);
  }

  executed(count = 1): void {
    this.#assertActive();
    this.#counts.executed += validateCount(count);
  }

  skipped(reason: SkipReason, count = 1): void {
    this.#assertActive();
    this.#counts.skipped[reason] += validateCount(count);
  }

  finish(nowNs = process.hrtime.bigint()): void {
    this.#assertActive();
    if (nowNs < this.#startedAtNs) {
      throw new RangeError("round finish time precedes its start time");
    }
    this.#finished = true;
    this.#owner.publishRound(
      this.#counts,
      Number(nowNs - this.#startedAtNs) / 1_000_000_000,
    );
  }

  #assertActive(): void {
    if (this.#finished) {
      throw new Error("round metrics have already been published");
    }
  }
}

export async function startMetricsServer(
  metrics: KeeperMetrics,
  options: { readonly host?: string; readonly port?: number } = {},
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 9464;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404).end("Not found\n");
      return;
    }
    void metrics.render().then(
      (body) => {
        response.writeHead(200, {
          "content-type": metrics.registry.contentType,
          "cache-control": "no-store",
        });
        response.end(body);
      },
      () => response.writeHead(500).end("Metrics unavailable\n"),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function validateCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("metric count must be a non-negative safe integer");
  }
  return count;
}
