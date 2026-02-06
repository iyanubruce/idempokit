import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Redis } from "ioredis";
import { RedisAdapter } from "../index";

// Use real Redis (requires `docker run -d -p 6379:6379 redis`)
const redis = new Redis();

const adapter = new RedisAdapter(redis);

beforeAll(async () => {
  // Verify Redis connection
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  const keys = await redis.keys("idemp:*");
  if (keys.length) await redis.del(...keys);
});

describe("RedisAdapter", () => {
  const key = "idemp:test-key";
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
      // Acquire lock + commit result
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      await adapter.commitResult(key, fingerprint, result, 10_000);

      // Subsequent call returns existing result
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({
        status: "exists",
        fingerprint,
        result,
        createdAt: expect.any(String),
      });
    });

    it("should handle corrupted Redis data gracefully", async () => {
      // Manually insert corrupted data
      await redis.set(key, '{"status":"proce');

      // Should treat as available (not crash)
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({ status: "acquired" });
    });
  });

  describe("commitResult", () => {
    it("should store result with retention", async () => {
      // Acquire lock first
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);

      // Commit result
      await adapter.commitResult(key, fingerprint, result, 10_000);

      // Verify stored value
      const stored = await redis.get(key);
      const data = JSON.parse(stored!);
      expect(data).toEqual({
        status: "committed",
        fingerprint,
        result,
        createdAt: expect.any(String),
      });
    });

    it("should reject commit without active lock", async () => {
      await expect(
        adapter.commitResult(key, fingerprint, result, 10_000),
      ).rejects.toThrow("Failed to commit result");
    });

    it("should reject double-commit", async () => {
      // First commit
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      await adapter.commitResult(key, fingerprint, result, 10_000);

      // Second commit should fail
      await expect(
        adapter.commitResult(key, fingerprint, result, 10_000),
      ).rejects.toThrow("Failed to commit result");
    });
  });

  describe("releaseLock", () => {
    it("should delete key when releasing lock", async () => {
      await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      await adapter.releaseLock(key);

      const exists = await redis.exists(key);
      expect(exists).toBe(0);
    });
  });

  describe("Integration", () => {
    it("should execute exactly once for duplicate requests", async () => {
      const handler = vi.fn(() => Promise.resolve(result));

      // First request
      const res1 = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      if (res1.status === "acquired") {
        await handler();
        await adapter.commitResult(key, fingerprint, result, 10_000);
      }

      // Duplicate request
      const res2 = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res2.status).toBe("exists");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should expire lock after TTL", async () => {
      // Acquire lock with short TTL
      await adapter.atomicCheckAndLock(key, fingerprint, 50); // 50ms

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be able to acquire new lock
      const res = await adapter.atomicCheckAndLock(key, fingerprint, 5_000);
      expect(res).toEqual({ status: "acquired" });
    });
  });
});
