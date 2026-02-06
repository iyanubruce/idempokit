/**
 * Core idempotency engine – storage-agnostic primitive for duplicate-safe operations.
 *
 * Enforces compliance-by-design:
 * - REQUIRED audit hook (no silent bypass)
 * - Mandatory 24h+ retention (PCI-DSS)
 * - Fingerprint enforcement (prevents $10 → $1000 replay attacks)
 * - Atomic check-or-lock (no race conditions)
 */
import { createHash } from "crypto";
import {
  IdempotencyStore,
  AuditEvent,
  EngineOptions,
  ExecuteOptions,
} from "./types";
import {
  InvalidIdempotencyKeyError,
  FingerprintMismatchError,
  InvalidRetentionError,
  OperationInProgressError,
  HandlerTimeoutError,
} from "./errors";

export class IdempotencyEngine {
  private readonly store: IdempotencyStore;
  private readonly options: Required<Omit<EngineOptions, "onAudit">> & {
    onAudit: (event: AuditEvent) => void | Promise<void>;
  };

  constructor(store: IdempotencyStore, options: EngineOptions) {
    // === VALIDATION: Enforce compliance boundaries ===
    if (options.lockTtl < 50 || options.lockTtl > 300_000) {
      throw new Error(
        `lockTtl must be between 50ms and 5m (got ${options.lockTtl}ms)`,
      );
    }

    if (options.retention < 86_400_000) {
      throw new InvalidRetentionError(
        `retention must be at least 24 hours (86400000ms) for PCI-DSS compliance (got ${options.retention}ms)`,
      );
    }

    // === CRITICAL: onAudit is REQUIRED – no default, no bypass ===
    if (typeof options.onAudit !== "function") {
      throw new Error(
        "onAudit is REQUIRED for compliance. Provide a function that writes to your audit system.\n" +
          "For development you can use: (e) => console.debug('[AUDIT]', e)",
      );
    }

    this.store = store;
    this.options = {
      lockTtl: options.lockTtl,
      retention: options.retention,
      onAudit: options.onAudit,
      fingerprintAlgorithm: options.fingerprintAlgorithm ?? "sha256",
      keyPrefix: options.keyPrefix ?? "",
    };
  }

  /**
   * Execute an idempotent operation.
   *
   * @param key - Client-provided idempotency key (MUST be from Idempotency-Key header)
   * @param fingerprint - SHA-256 of normalized request body (prevents replay attacks)
   * @param handler - Your business logic (payment processing, etc.)
   * @param options - Per-request overrides (timeout, retention, audit context)
   *
   * @returns Cached result if duplicate, or fresh result from handler
   * @throws FingerprintMismatchError if key reused with different payload
   * @throws OperationInProgressError if concurrent request is already processing
   * @throws HandlerTimeoutError if handler exceeds timeout
   */
  async execute<T>(
    key: string,
    fingerprint: string,
    handler: () => Promise<T>,
    options?: ExecuteOptions,
  ): Promise<T> {
    // === VALIDATION: Reject invalid keys early ===
    if (!key || typeof key !== "string" || key.trim().length === 0) {
      throw new InvalidIdempotencyKeyError(
        "idempotency key must be a non-empty string (from Idempotency-Key header)",
      );
    }

    // === KEY NAMESPACING ===
    const fullKey = this.options.keyPrefix + key.trim();

    // === TIMEOUT SETUP (handler execution, NOT lock acquisition) ===
    const handlerTimeout = options?.handlerTimeout ?? 30_000; // 30s default
    if (handlerTimeout < 50 || handlerTimeout > 300_000) {
      throw new Error(
        `handlerTimeout must be 50ms–5m (got ${handlerTimeout}ms)`,
      );
    }

    // === RETENTION OVERRIDE VALIDATION ===
    const retentionMs = options?.retentionOverride ?? this.options.retention;
    if (retentionMs < 86_400_000) {
      throw new InvalidRetentionError(
        `retentionOverride must be ≥24h (got ${retentionMs}ms)`,
      );
    }

    // === ATOMIC: Check existing result OR acquire lock ===
    const checkResult = await this.store.atomicCheckAndLock(
      fullKey,
      fingerprint,
      this.options.lockTtl,
    );

    // === CASE 1: Result already exists (cache hit) ===
    if (checkResult.status === "exists") {
      // SECURITY: Enforce fingerprint matching to prevent replay attacks
      if (checkResult.fingerprint !== fingerprint) {
        await this._audit(
          {
            timestamp: new Date().toISOString(),
            key: fullKey,
            action: "fingerprint_mismatch",
            fingerprint,
            storedFingerprint: checkResult.fingerprint,
            metadata: options?.metadata,
          },
          options?.onAudit ?? this.options.onAudit,
        );

        throw new FingerprintMismatchError(
          `Fingerprint mismatch for key ${key} – possible replay attack or key reuse with different payload`,
        );
      }

      await this._audit(
        {
          timestamp: new Date().toISOString(),
          key: fullKey,
          action: "hit",
          fingerprint,
          metadata: options?.metadata,
        },
        options?.onAudit ?? this.options.onAudit,
      );

      return checkResult.result as T;
    }

    // === CASE 2: Already locked (concurrent request in progress) ===
    if (checkResult.status === "locked") {
      await this._audit(
        {
          timestamp: new Date().toISOString(),
          key: fullKey,
          action: "locked",
          metadata: options?.metadata,
        },
        options?.onAudit ?? this.options.onAudit,
      );

      throw new OperationInProgressError(
        `Operation for key ${key} is already in progress (lock held by concurrent request)`,
      );
    }

    // === CASE 3: Lock acquired – execute handler ===
    await this._audit(
      {
        timestamp: new Date().toISOString(),
        key: fullKey,
        action: "acquired",
        fingerprint,
        metadata: options?.metadata,
      },
      options?.onAudit ?? this.options.onAudit,
    );

    try {
      // === ENFORCE HANDLER TIMEOUT (prevents zombie locks) ===
      const result = await Promise.race([
        handler(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new HandlerTimeoutError(
                  `Handler timeout after ${handlerTimeout}ms`,
                ),
              ),
            handlerTimeout,
          ),
        ),
      ]);

      // === COMMIT RESULT WITH RETENTION (NOT lockTtl!) ===
      await this.store.commitResult(fullKey, fingerprint, result, retentionMs);

      await this._audit(
        {
          timestamp: new Date().toISOString(),
          key: fullKey,
          action: "stored",
          fingerprint,
          metadata: options?.metadata,
        },
        options?.onAudit ?? this.options.onAudit,
      );

      return result;
    } catch (err) {
      // === AUDIT ERRORS (without leaking sensitive data) ===
      await this._audit(
        {
          timestamp: new Date().toISOString(),
          key: fullKey,
          action: err instanceof HandlerTimeoutError ? "timeout" : "error",
          fingerprint,
          metadata: {
            ...options?.metadata,
            error: err instanceof Error ? err.message : String(err),
            errorCode: err instanceof Error ? err.name : undefined,
          },
        },
        options?.onAudit ?? this.options.onAudit,
      );

      throw err;
    } finally {
      // === BEST-EFFORT LOCK RELEASE (prevents zombie locks) ===
      try {
        await this.store.releaseLock?.(fullKey);

        await this._audit(
          {
            timestamp: new Date().toISOString(),
            key: fullKey,
            action: "lock_released",
            metadata: options?.metadata,
          },
          options?.onAudit ?? this.options.onAudit,
        );
      } catch {
        // Ignore release failures – TTL will expire lock eventually
      }
    }
  }

  /**
   * Generate a normalized fingerprint from request data.
   *
   * Normalization ensures:
   * - Key order independence: {a:1,b:2} === {b:2,a:1}
   * - Type stability: numbers stay numbers, strings stay strings
   * - Excludes volatile fields (timestamps, nonces) by convention
   *
   * ⚠️ SECURITY: Do NOT include timestamps/nonces that change per request
   * for the same logical operation (breaks idempotency)
   */

  fingerprint(data: unknown): string {
    // Normalize: sort object keys recursively to avoid false mismatches
    const normalize = (value: unknown): unknown => {
      if (value == null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(normalize);

      // Sort keys for deterministic serialization
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    };

    const normalized = JSON.stringify(normalize(data));
    const hash = createHash(this.options.fingerprintAlgorithm);
    hash.update(normalized);
    return hash.digest("hex");
  }

  /**
   * Internal audit dispatcher – never fails, never leaks sensitive data.
   */
  private async _audit(
    event: AuditEvent,
    auditor: (event: AuditEvent) => void | Promise<void>,
  ): Promise<void> {
    try {
      // NEVER include sensitive data – strip anything risky just in case
      const safeEvent: AuditEvent = {
        timestamp: event.timestamp,
        key: event.key,
        action: event.action,
        fingerprint: event.fingerprint,
        storedFingerprint: event.storedFingerprint,
        metadata: event.metadata
          ? Object.fromEntries(
              Object.entries(event.metadata).filter(
                ([k]) =>
                  !k.match(
                    /(password|token|secret|card|cvv|pin|ssn|full.?name|email|phone)/i,
                  ),
              ),
            )
          : undefined,
      };

      await Promise.resolve(auditor(safeEvent));
      await this.store.recordAudit?.(safeEvent);
    } catch {
      // Audit failures MUST NEVER affect business logic
      // (But should be monitored via application metrics)
    }
  }
}
