import { DatabaseClient } from "./client.js";

export interface TaskOutcome {
  taskId: bigint;
  taskType: string;
  status: "claimed" | "executed" | "skipped";
  keeperAddress?: string;
  profitStroops: bigint;
  skipReason?: string;
  claimedAt?: Date;
  executedAt?: Date;
}

export class TaskStateStore {
  constructor(private db: DatabaseClient) {}

  public async init(): Promise<void> {
    await this.db.migrate();
  }

  public async recordClaim(taskId: bigint, taskType: string, keeperAddress: string): Promise<void> {
    const sql = `
      INSERT INTO keeper_task_outcomes (task_id, task_type, status, keeper_address, claimed_at, updated_at)
      VALUES ($1, $2, 'claimed', $3, NOW(), NOW())
      ON CONFLICT (task_id) DO UPDATE SET
        status = 'claimed',
        keeper_address = EXCLUDED.keeper_address,
        claimed_at = NOW(),
        updated_at = NOW()
    `;
    await this.db.query(sql, [taskId.toString(), taskType, keeperAddress]);
  }

  public async recordExecution(
    taskId: bigint,
    taskType: string,
    keeperAddress: string,
    profitStroops: bigint
  ): Promise<void> {
    const sql = `
      INSERT INTO keeper_task_outcomes (task_id, task_type, status, keeper_address, profit_stroops, executed_at, updated_at)
      VALUES ($1, $2, 'executed', $3, $4, NOW(), NOW())
      ON CONFLICT (task_id) DO UPDATE SET
        status = 'executed',
        keeper_address = EXCLUDED.keeper_address,
        profit_stroops = EXCLUDED.profit_stroops,
        executed_at = NOW(),
        updated_at = NOW()
    `;
    await this.db.query(sql, [taskId.toString(), taskType, keeperAddress, profitStroops.toString()]);
  }

  public async recordSkip(taskId: bigint, taskType: string, reason: string): Promise<void> {
    const sql = `
      INSERT INTO keeper_task_outcomes (task_id, task_type, status, skip_reason, updated_at)
      VALUES ($1, $2, 'skipped', $3, NOW())
      ON CONFLICT (task_id) DO UPDATE SET
        status = 'skipped',
        skip_reason = EXCLUDED.skip_reason,
        updated_at = NOW()
    `;
    await this.db.query(sql, [taskId.toString(), taskType, reason]);
  }

  public async isTaskProcessed(taskId: bigint): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM keeper_task_outcomes WHERE task_id = $1 AND status IN ('executed', 'skipped') LIMIT 1`,
      [taskId.toString()]
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  public async loadProcessedTaskIds(): Promise<Set<bigint>> {
    const res = await this.db.query<{ task_id: string }>(
      `SELECT task_id FROM keeper_task_outcomes WHERE status IN ('executed', 'skipped')`
    );
    const set = new Set<bigint>();
    for (const row of res.rows) {
      set.add(BigInt(row.task_id));
    }
    return set;
  }

  public async getOutcome(taskId: bigint): Promise<TaskOutcome | null> {
    const res = await this.db.query<{
      task_id: string;
      task_type: string;
      status: "claimed" | "executed" | "skipped";
      keeper_address: string | null;
      profit_stroops: string;
      skip_reason: string | null;
      claimed_at: Date | null;
      executed_at: Date | null;
    }>(`SELECT * FROM keeper_task_outcomes WHERE task_id = $1`, [taskId.toString()]);

    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return {
      taskId: BigInt(r.task_id),
      taskType: r.task_type,
      status: r.status,
      keeperAddress: r.keeper_address || undefined,
      profitStroops: BigInt(r.profit_stroops || "0"),
      skipReason: r.skip_reason || undefined,
      claimedAt: r.claimed_at || undefined,
      executedAt: r.executed_at || undefined,
    };
  }
}
