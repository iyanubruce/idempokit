// src/__tests__/mocks/memory-store.ts
import { IdempotencyStore, AuditEvent } from "../../types";

export class MemoryStore implements IdempotencyStore {
  private store = new Map<string, any>();
  private auditLog: AuditEvent[] = [];

  async atomicCheckAndLock(
    key: string,
    providedFingerprint: string,
    lockTtlMs: number,
  ) {
    const existing = this.store.get(key);

    if (existing) {
      if (existing.status === "processing") {
        return { status: "locked" as const };
      }
      return {
        status: "exists" as const,
        fingerprint: existing.fingerprint,
        result: existing.result,
        createdAt: existing.createdAt,
      };
    }

    // Acquire lock
    this.store.set(key, {
      status: "processing",
      lockAcquiredAt: Date.now(),
      lockTtlMs,
    });

    // Auto-expire lock after TTL (simulate Redis PX)
    setTimeout(() => {
      const current = this.store.get(key);
      if (current?.status === "processing") {
        this.store.delete(key);
      }
    }, lockTtlMs);

    return { status: "acquired" as const };
  }

  async commitResult(
    key: string,
    fingerprint: string,
    result: unknown,
    retentionMs: number,
  ) {
    const current = this.store.get(key);
    if (!current || current.status !== "processing") {
      throw new Error("Cannot commit: lock not held or expired");
    }

    this.store.set(key, {
      status: "committed",
      fingerprint,
      result,
      createdAt: new Date().toISOString(),
    });

    // Auto-expire after retention
    setTimeout(() => {
      const current = this.store.get(key);
      if (current?.status === "committed") {
        this.store.delete(key);
      }
    }, retentionMs);
  }

  async releaseLock(key: string) {
    const current = this.store.get(key);
    if (current?.status === "processing") {
      this.store.delete(key);
    }
  }

  async recordAudit(event: AuditEvent) {
    this.auditLog.push(event);
  }

  getAuditLog() {
    return this.auditLog;
  }

  clear() {
    this.store.clear();
    this.auditLog = [];
  }
}
