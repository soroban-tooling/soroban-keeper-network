import pg from "pg";
import { INIT_SCHEMA_SQL } from "./schema.js";

const { Pool } = pg;

export class DatabaseClient {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  public async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(INIT_SCHEMA_SQL);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  public async query<R extends pg.QueryResultRow = any>(
    sql: string,
    params?: any[]
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(sql, params);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
