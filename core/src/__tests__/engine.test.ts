import { describe, it, expect, beforeEach, vi } from "vitest";
import { IdempotencyEngine } from "../engine";
import { MemoryStore } from "./mocks/memory-store";
import {
  FingerprintMismatchError,
  InvalidIdempotencyKeyError,
  InvalidRetentionError,
  OperationInProgressError,
  HandlerTimeoutError,
} from "../errors";

describe("IdempotencyEngine", () => {
  let engine: IdempotencyEngine;
  let auditMock: any;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    auditMock = vi.fn();
    engine = new IdempotencyEngine(store, {
      lockTtl: 30_000,
      retention: 86_400_000,
      onAudit: auditMock,
    });
  });

  describe("Basic Idempotency", () => {
    it("should execute handler exactly once for duplicate requests", async () => {
      const handler = vi.fn(() => Promise.resolve({ success: true }));
      const key = "test-key";
      const fp = engine.fingerprint({ amount: 100 });

      const result1 = await engine.execute(key, fp, handler);
      const result2 = await engine.execute(key, fp, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(result2);
      expect(result1).toEqual({ success: true });
    });

    it("should allow concurrent requests with different keys", async () => {
      const handler = vi.fn((id: string) =>
        Promise.resolve({ id, timestamp: Date.now() }),
      );

      const results = await Promise.all([
        engine.execute("key-1", engine.fingerprint({ id: 1 }), () =>
          handler("req1"),
        ),
        engine.execute("key-2", engine.fingerprint({ id: 2 }), () =>
          handler("req2"),
        ),
        engine.execute("key-3", engine.fingerprint({ id: 3 }), () =>
          handler("req3"),
        ),
      ]);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(3);
    });
  });

  describe("Security", () => {
    it("should reject with FingerprintMismatchError when fingerprints differ", async () => {
      const handler = vi.fn(() => Promise.resolve({ amount: 100 }));
      const key = "test-key";
      const fp1 = engine.fingerprint({ amount: 100 });
      const fp2 = engine.fingerprint({ amount: 200 });

      await engine.execute(key, fp1, handler);

      await expect(engine.execute(key, fp2, handler)).rejects.toThrow(
        FingerprintMismatchError,
      );
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should filter PII from audit events", async () => {
      const handler = () => Promise.resolve({ success: true });
      const key = "pii-filter-key";
      const fp = engine.fingerprint({ test: true });

      await engine.execute(key, fp, handler, {
        metadata: {
          password: "secret123",
          email: "user@example.com",
          ssn: "123-45-6789",
          cvv: "123",
          cardNumber: "4111111111111111",
          requestId: "req_123",
          clientId: "client_456",
          ip: "192.168.1.1",
        },
      });

      const auditCalls = auditMock.mock.calls.map(([e]: any[]) => e);
      for (const event of auditCalls) {
        if (event.metadata) {
          // PII fields should be stripped
          expect(event.metadata).not.toHaveProperty("password");
          expect(event.metadata).not.toHaveProperty("email");
          expect(event.metadata).not.toHaveProperty("ssn");
          expect(event.metadata).not.toHaveProperty("cvv");
          expect(event.metadata).not.toHaveProperty("cardNumber");

          // Safe fields should remain
          expect(event.metadata).toHaveProperty("requestId");
          expect(event.metadata).toHaveProperty("clientId");
          expect(event.metadata).toHaveProperty("ip");
        }
      }
    });
  });

  describe("Concurrency", () => {
    it("should reject with OperationInProgressError during lock contention", async () => {
      let resolveHandler: () => void;
      const slowHandler = () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }).then(() => ({ done: true }));

      const key = "concurrent-key";
      const fp = engine.fingerprint({ test: true });

      const req1Promise = engine.execute(key, fp, slowHandler);
      const req2Promise = engine.execute(key, fp, async () => ({
        shouldNotRun: true,
      }));

      await expect(req2Promise).rejects.toThrow(OperationInProgressError);

      resolveHandler!();
      const result1 = await req1Promise;
      expect(result1).toEqual({ done: true });
    });
  });

  describe("Validation", () => {
    it("should enforce 24h minimum retention", () => {
      expect(
        () =>
          new IdempotencyEngine(store, {
            lockTtl: 30_000,
            retention: 1_000,
            onAudit: auditMock,
          }),
      ).toThrow(InvalidRetentionError);
    });

    it(`should enforce lockTtl between 50ms and 5m`, () => {
      expect(
        () =>
          new IdempotencyEngine(store, {
            lockTtl: 600_000,
            retention: 86_400_000,
            onAudit: auditMock,
          }),
      ).toThrow(`lockTtl must be between 50ms and 5m (got 600000ms)`);
    });

    it("should reject empty or invalid keys", async () => {
      const handler = () => Promise.resolve({ success: true });
      const fp = engine.fingerprint({ test: true });

      await expect(engine.execute("", fp, handler)).rejects.toThrow(
        InvalidIdempotencyKeyError,
      );
      await expect(engine.execute("   ", fp, handler)).rejects.toThrow(
        InvalidIdempotencyKeyError,
      );
      await expect(engine.execute(null as any, fp, handler)).rejects.toThrow(
        InvalidIdempotencyKeyError,
      );
    });

    it("should validate retentionOverride", async () => {
      const handler = () => Promise.resolve({ success: true });
      const key = "override-key";
      const fp = engine.fingerprint({ test: true });

      await expect(
        engine.execute(key, fp, handler, { retentionOverride: 1_000 }),
      ).rejects.toThrow(InvalidRetentionError);
    });
  });

  describe("Key Prefixing", () => {
    it("should apply key prefix correctly", async () => {
      const prefixedEngine = new IdempotencyEngine(store, {
        lockTtl: 30_000,
        retention: 86_400_000,
        onAudit: auditMock,
        keyPrefix: "test-prefix:",
      });

      const handler = vi.fn(() => Promise.resolve({ success: true }));
      const key = "my-key";
      const fp = prefixedEngine.fingerprint({ test: true });

      await prefixedEngine.execute(key, fp, handler);

      const auditCalls = auditMock.mock.calls;
      expect(
        auditCalls.some(([e]: any[]) => e.key === "test-prefix:my-key"),
      ).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle handler errors gracefully", async () => {
      const failingHandler = () => Promise.reject(new Error("Handler failed"));
      const key = "error-key";
      const fp = engine.fingerprint({ test: true });

      await expect(engine.execute(key, fp, failingHandler)).rejects.toThrow(
        "Handler failed",
      );

      const auditCalls = auditMock.mock.calls.map(([e]: any[]) => e.action);
      expect(auditCalls).toContain("lock_released");
      expect(auditCalls).toContain("error");
    });

    it("should handle handler timeout and release lock", async () => {
      const neverResolves = () => new Promise(() => {});
      const key = "timeout-lock-key";
      const fp = engine.fingerprint({ test: true });

      await expect(
        engine.execute(key, fp, neverResolves, { handlerTimeout: 50 }),
      ).rejects.toThrow(HandlerTimeoutError);

      const auditCalls = auditMock.mock.calls.map(([e]: any[]) => e.action);
      expect(auditCalls).toContain("lock_released");
      expect(auditCalls).toContain("timeout");
    });
  });

  describe("Audit", () => {
    it("should call audit hook for every significant event", async () => {
      const handler = () => Promise.resolve({ success: true });
      const key = "audit-key";
      const fp = engine.fingerprint({ test: true });

      await engine.execute(key, fp, handler);

      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "acquired",
          key: "audit-key",
        }),
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "stored",
          key: "audit-key",
        }),
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "lock_released",
          key: "audit-key",
        }),
      );
    });

    it("should use per-request audit override", async () => {
      const overrideAudit = vi.fn();
      const handler = () => Promise.resolve({ success: true });
      const key = "override-audit-key";
      const fp = engine.fingerprint({ test: true });

      await engine.execute(key, fp, handler, {
        onAudit: overrideAudit,
        metadata: { custom: "value" },
      });

      expect(overrideAudit).toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  });

  describe("Fingerprinting", () => {
    it("should normalize fingerprints (key order independence)", () => {
      const fp1 = engine.fingerprint({ a: 1, b: 2, c: 3 });
      const fp2 = engine.fingerprint({ c: 3, b: 2, a: 1 });
      const fp3 = engine.fingerprint({ b: 2, a: 1, c: 3 });

      expect(fp1).toBe(fp2);
      expect(fp2).toBe(fp3);
    });

    it("should normalize nested objects", () => {
      const fp1 = engine.fingerprint({
        user: { id: "123", name: "Alice" },
        amount: 100,
      });
      const fp2 = engine.fingerprint({
        amount: 100,
        user: { name: "Alice", id: "123" },
      });

      expect(fp1).toBe(fp2);
    });

    it("should handle arrays consistently", () => {
      const fp1 = engine.fingerprint({ items: [1, 2, 3] });
      const fp2 = engine.fingerprint({ items: [1, 2, 3] });

      expect(fp1).toBe(fp2);
    });
  });

  describe("Timeout", () => {
    it("should timeout handler that exceeds handlerTimeout", async () => {
      const slowHandler = () => new Promise(() => {});
      const key = "timeout-key";
      const fp = engine.fingerprint({ test: true });

      await expect(
        engine.execute(key, fp, slowHandler, { handlerTimeout: 100 }),
      ).rejects.toThrow(HandlerTimeoutError);
    });
  });
});
