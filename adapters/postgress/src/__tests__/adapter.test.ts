// src/__tests__/adapter.test.ts
import { Pool } from "pg";
import { PostgresAdapter, createIdempotencyTables } from "../index";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const pool = new Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5432/postgres",
});

const adapter = new PostgresAdapter(pool);

beforeAll(async () => {
  await createIdempotencyTables(pool);
});

afterAll(async () => {
  await pool.end();
}, 30_000);

beforeEach(async () => {
  await pool.query("DELETE FROM idempotency_keys");
  await pool.query("DELETE FROM idempotency_audit");
});

describe("PostgresAdapter", () => {
  const key = "idemp:test-key";
  const fingerprint = "fp123";
  const result = { paymentId: "pay_123" };

  describe("atomicCheckAndLock", () => {
    it("should acquire lock for new key", async () => {
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({ status: "acquired" });
    });

    it('should return "locked" for concurrent request', async () => {
      // Simulate another transaction holding the lock
      const client1 = await pool.connect();
      await client1.query("BEGIN");
      await client1.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);

      // Our adapter should detect the lock
      const res2 = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res2).toEqual({ status: "locked" });

      // Cleanup
      await client1.query("COMMIT");
      client1.release();
    });

    it("should return existing result after commit", async () => {
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      await adapter.commitResult(key, fingerprint, result, 10_000);

      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({
        status: "exists",
        fingerprint,
        result,
        createdAt: expect.any(String),
      });
    });
  });

  describe("commitResult", () => {
    it("should store result with retention", async () => {
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      await adapter.commitResult(key, fingerprint, result, 10_000);

      const { rows } = await pool.query(
        "SELECT fingerprint, result FROM idempotency_keys WHERE key = $1",
        [key],
      );
      expect(rows[0]).toEqual({
        fingerprint,
        result,
      });
    });

    it("should reject commit when result already exists", async () => {
      // Create existing result
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      await adapter.commitResult(key, fingerprint, result, 10_000);

      // Attempt to commit again
      await expect(
        adapter.commitResult(key, fingerprint, { new: true }, 10_000),
      ).rejects.toThrow("Result already exists for this key");
    });
  });

  describe("recordAudit", () => {
    it("should store audit events", async () => {
      const auditEvent = {
        timestamp: new Date().toISOString(),
        key: "test-key",
        action: "stored" as const,
        fingerprint: "fp123",
        metadata: { requestId: "req_123" },
      };

      await adapter.recordAudit(auditEvent);

      const { rows } = await pool.query(
        "SELECT key, action, fingerprint, metadata FROM idempotency_audit WHERE key = $1",
        ["test-key"],
      );

      expect(rows[0]).toEqual({
        key: "test-key",
        action: "stored",
        fingerprint: "fp123",
        metadata: { requestId: "req_123" },
      });
    });
  });

  describe("Integration", () => {
    it("should execute exactly once for duplicate requests", async () => {
      const handler = vi.fn(() => Promise.resolve(result));

      const res1 = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      if (res1.status === "acquired") {
        await handler();
        await adapter.commitResult(key, fingerprint, result, 10_000);
      }

      const res2 = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res2.status).toBe("exists");
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
