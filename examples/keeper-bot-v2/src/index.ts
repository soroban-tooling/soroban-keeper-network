import "dotenv/config";
import { validateConfig, KeeperBotV2Config } from "./config.js";
import { MetricsCollector, startMetricsServer } from "./metrics.js";
import { DatabaseClient } from "./db/client.js";
import { TaskStateStore } from "./db/store.js";
import { ExecutorRegistry } from "./executors/registry.js";
import { TaskExecutor, TaskExecutionPayload, TaskExecutionResult } from "./executors/interface.js";

export * from "./config.js";
export * from "./metrics.js";
export * from "./db/client.js";
export * from "./db/schema.js";
export * from "./db/store.js";
export * from "./executors/interface.js";
export * from "./executors/registry.js";

class TtlExtensionExecutor implements TaskExecutor {
  public readonly taskType = "ttl_extension";

  async execute(_task: TaskExecutionPayload): Promise<TaskExecutionResult> {
    return {
      success: true,
      proof: Buffer.from("ttl_extended"),
      estimatedCostStroops: 1000n,
    };
  }
}

class SimulatedExecutor implements TaskExecutor {
  public readonly taskType = "simulated";

  async execute(_task: TaskExecutionPayload): Promise<TaskExecutionResult> {
    return {
      success: true,
      proof: Buffer.from("simulated_proof"),
      estimatedCostStroops: 500n,
    };
  }
}

export class KeeperBotV2 {
  public readonly config: KeeperBotV2Config;
  public readonly metrics: MetricsCollector;
  public readonly executorRegistry: ExecutorRegistry;
  public dbClient?: DatabaseClient;
  public store?: TaskStateStore;

  private isRunning = false;
  private metricsServer?: ReturnType<typeof startMetricsServer>;

  constructor(config: KeeperBotV2Config) {
    this.config = config;
    this.metrics = new MetricsCollector();
    this.executorRegistry = new ExecutorRegistry(this.metrics);

    // Register built-in default executors
    this.executorRegistry.register(new TtlExtensionExecutor());
    if (this.config.simulateExecution) {
      this.executorRegistry.register(new SimulatedExecutor());
    }

    if (this.config.databaseUrl) {
      this.dbClient = new DatabaseClient(this.config.databaseUrl);
      this.store = new TaskStateStore(this.dbClient);
    }
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    console.log(`[KEEPER-BOT-V2] Starting on network '${this.config.network}' with registry '${this.config.registryContractId}'`);
    console.log(`[KEEPER-BOT-V2] Concurrency limit: ${this.config.maxConcurrentTasks} worker(s), Signing pool size: ${this.config.signingKeys.length}`);

    if (this.store) {
      console.log(`[KEEPER-BOT-V2] Connecting to PostgreSQL persistent store...`);
      await this.store.init();
      const existing = await this.store.loadProcessedTaskIds();
      console.log(`[KEEPER-BOT-V2] Persistent store ready with ${existing.size} previously processed task(s).`);
    } else {
      console.log(`[KEEPER-BOT-V2] Operating without persistent database. Task states will be in-memory.`);
    }

    if (this.config.metricsEnabled) {
      this.metricsServer = startMetricsServer(this.metrics, this.config.metricsPort);
      console.log(`[KEEPER-BOT-V2] Prometheus metrics listening on :${this.config.metricsPort}/metrics`);
    }

    if (this.config.runOnce) {
      console.log(`[KEEPER-BOT-V2] Running in single-round mode (--once)`);
      await this.runRound();
      await this.stop();
      return;
    }

    this.scheduleNextRound();
  }

  public async runRound(): Promise<void> {
    const start = Date.now();
    try {
      this.metrics.recordEvaluation(0);
      // Main polling loop execution would poll RPC events here
    } finally {
      const elapsedSec = (Date.now() - start) / 1000;
      this.metrics.setRoundDuration(elapsedSec);
    }
  }

  private scheduleNextRound(): void {
    if (!this.isRunning) return;
    setTimeout(async () => {
      if (!this.isRunning) return;
      await this.runRound();
      this.scheduleNextRound();
    }, this.config.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    console.log(`[KEEPER-BOT-V2] Shutting down...`);
    if (this.metricsServer) {
      this.metricsServer.close();
    }
    if (this.dbClient) {
      await this.dbClient.close();
    }
    console.log(`[KEEPER-BOT-V2] Stopped cleanly.`);
  }
}

// CLI launcher if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const config = validateConfig(process.env);
    const bot = new KeeperBotV2(config);

    const shutdown = async () => {
      await bot.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    bot.start().catch((err) => {
      console.error("[KEEPER-BOT-V2 FATAL]", err);
      process.exit(1);
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`[CONFIG ERROR] ${err.message}`);
    }
    process.exit(1);
  }
}
