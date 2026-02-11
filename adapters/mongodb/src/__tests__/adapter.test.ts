import { MongoClient, Db } from "mongodb";
import {
  MongoAdapter,
  setupMongoCollections,
  IdempotencyKeyDoc,
} from "../index";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
// src/__tests__/adapter.test.ts

const MONGODB_URI = "mongodb://localhost:27017";
const DB_NAME = "idempotkit_test";

let client: MongoClient;
let db: Db;
let adapter: MongoAdapter;

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);

  // Setup collections with validation
  await setupMongoCollections(db);

  adapter = new MongoAdapter(db);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // Clear collections before each test
  await db.collection("idempotency_keys").deleteMany({});
  await db.collection("idempotency_audit").deleteMany({});
});

describe("MongoAdapter", () => {
  const key = "test-key";
  const fingerprint = "fp123";
  const result = { paymentId: "pay_123" };

  describe("atomicCheckAndLock", () => {
    it("should acquire lock for new key", async () => {
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({ status: "acquired" });
    });

    it('should return "locked" for concurrent request', async () => {
      // First call acquires lock
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);

      // Second call should be locked
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({ status: "locked" });
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
      const doc = await db
        .collection<IdempotencyKeyDoc>("idempotency_keys")
        .findOne({ _id: key });
      expect(doc).toMatchObject({
        _id: key,
        fingerprint,
        result,
        status: "committed",
      });
      expect(doc!.expiresAt).toBeInstanceOf(Date);
    });

    it("should reject commit without active lock", async () => {
      await expect(
        adapter.commitResult(key, fingerprint, result, 10_000),
      ).rejects.toThrow("Cannot commit result");
    });
  });

  describe("recordAudit", () => {
    it("should store audit events", async () => {
      const auditEvent = {
        timestamp: new Date().toISOString(),
        key: "audit-test",
        action: "stored" as const,
        fingerprint: "fp456",
        metadata: { requestId: "req_123" },
      };

      await adapter.recordAudit(auditEvent);

      const doc = await db
        .collection("idempotency_audit")
        .findOne({ key: "audit-test" });
      expect(doc).toMatchObject({
        key: "audit-test",
        action: "stored",
        fingerprint: "fp456",
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

    it("should handle TTL expiration", async () => {
      // Create processing document with short TTL
      await adapter.atomicCheckAndLock(key, fingerprint, 50); // 50ms

      // Wait for TTL to expire (MongoDB TTL runs every 60 seconds by default,
      // but for testing we'll simulate by waiting and then treating as expired)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be able to acquire new lock
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({ status: "acquired" });
    });
  });
});
