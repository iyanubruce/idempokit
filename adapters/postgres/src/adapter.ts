import { IdempotencyStore, AuditEvent } from "@idempotkit/core";
import { Pool, PoolClient } from "pg";

export class PostgresAdapter implements IdempotencyStore {
  constructor(
    private pool: Pool,
    private options: { schema?: string } = {},
  ) {}

  private getTable(name: string): string {
    return this.options.schema
      ? `"${this.options.schema}"."${name}"`
      : `"${name}"`;
  }

  async atomicCheckAndLock(
    key: string,
    fingerprint: string,
    lockTtlMs: number,
  ) {
    const client = await this.pool.connect();
    try {
      // Use a single transaction that commits/rolls back immediately
      await client.query("BEGIN");

      // Check for existing result
      const { rows } = await client.query(
        `SELECT fingerprint, result, created_at::text 
       FROM ${this.getTable("idempotency_keys")} 
       WHERE key = $1 AND expires_at > NOW()`,
        [key],
      );

      if (rows.length > 0) {
        await client.query("ROLLBACK");
        return {
          status: "exists" as const,
          fingerprint: rows[0].fingerprint,
          result: rows[0].result,
          createdAt: rows[0].created_at,
        };
      }

      // Try to acquire advisory lock WITHOUT holding transaction
      const { rows: lockRows } = await client.query(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [key],
      );

      if (!lockRows[0].locked) {
        await client.query("ROLLBACK");
        return { status: "locked" as const };
      }

      // Successfully acquired lock - release it immediately
      // The actual lock will be re-acquired in commitResult if needed
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]);
      await client.query("COMMIT");

      return { status: "acquired" as const };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // In commitResult method
  async commitResult(
    key: string,
    fingerprint: string,
    result: unknown,
    retentionMs: number,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // ✅ CORRECT VALIDATION: Check if result already exists
      const { rows } = await client.query(
        `SELECT 1 FROM ${this.getTable("idempotency_keys")} 
       WHERE key = $1 AND expires_at > NOW()`,
        [key],
      );

      if (rows.length > 0) {
        await client.query("ROLLBACK");
        throw new Error("Result already exists for this key");
      }

      // Store new result
      await client.query(
        `INSERT INTO ${this.getTable("idempotency_keys")} 
       (key, fingerprint, result, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4 || ' milliseconds')::interval)`,
        [key, fingerprint, JSON.stringify(result), retentionMs],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async recordAudit(event: AuditEvent) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ${this.getTable("idempotency_audit")} 
         (key, action, fingerprint, metadata)
         VALUES ($1, $2, $3, $4)`,
        [
          event.key,
          event.action,
          event.fingerprint || null,
          event.metadata ? JSON.stringify(event.metadata) : null,
        ],
      );
    } finally {
      client.release();
    }
  }

  // Advisory locks auto-release when transaction ends
  async releaseLock(_key: string) {
    // No-op - lock released when transaction ends in atomicCheckAndLock
  }
}

// In @idempotkit/postgres-adapter
export async function createIdempotencyTables(
  pool: Pool,
  options?: { schema?: string },
) {
  const schema = options?.schema ? `"${options.schema}"` : "public";

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.idempotency_keys (
      key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${schema}.idempotency_audit (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      action TEXT NOT NULL,
      fingerprint TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Optional: Add cleanup index
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires 
    ON ${schema}.idempotency_keys (expires_at);
  `);

  // Make audit table append-only (compliance best practice)
  console.log(
    `[IdempotKit] ⚠️ For PCI-DSS compliance, REVOKE UPDATE/DELETE on idempotency_audit:\n` +
      `REVOKE UPDATE, DELETE ON ${schema}.idempotency_audit FROM your_app_user;`,
  );
}
