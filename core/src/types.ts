export interface EngineOptions {
  /**
   * Duration (ms) to hold the lock while the handler is running.
   * Prevents concurrent execution of the same idempotency key.
   * Recommended range: 5_000 – 60_000 ms.
   */
  lockTtl: number;

  /**
   * Duration (ms) to keep the result stored for retry responses.
   * Must be at least 86_400_000 ms (24 hours) for PCI-DSS compliance.
   */

  retention: number;

  /**
   * REQUIRED: Audit callback for compliance logging.
   * Called for every significant event (hit, miss, store, mismatch, etc.).
   * Must not throw — audit failures are silently ignored.
   */
  onAudit: (event: AuditEvent) => void | Promise<void>;

  /**
   * Hash algorithm used for generating fingerprints.
   * @default "sha256"
   */
  fingerprintAlgorithm?: string;

  /**
   * Prefix prepended to all storage keys.
   * Useful for namespacing (e.g., "dev:", "prod:", "tenant-123:").
   * @default ""
   */
  keyPrefix?: string;
}
export interface ExecuteOptions {
  onAudit?: (event: AuditEvent) => void;
  handlerTimeout?: number; // ms – lock acquisition timeout
  retentionOverride?: number; // override global retention
  metadata?: Record<string, unknown>; // optional: requestId, clientId, ip, etc.
}

/**
 * Interface that all storage adapters (Redis, Postgres, DynamoDB, etc.) must implement.
 *
 * The goal is to make the core engine agnostic to storage while enforcing:
 * - Atomic check-or-lock to prevent race conditions
 * - Separation of lock duration vs result retention
 * - Safe audit handling (no sensitive data)
 * - Best-effort cleanup
 */
export interface IdempotencyStore {
  /**
   * ATOMIC operation: Check if a result already exists for this key OR attempt to acquire a lock.
   *
   * This must be implemented as a single atomic operation (Lua script in Redis,
   * conditional writes in DynamoDB, transaction + advisory lock in Postgres, etc.).
   *
   * @param key - The full idempotency key (already prefixed if configured)
   * @param providedFingerprint - The fingerprint from the current request
   * @param lockTtlMs - How long to hold the lock (typically 10–60 seconds)
   *
   * @returns Promise with one of three outcomes:
   *   - Result already exists → return it so engine can compare fingerprints
   *   - Already locked/processing → tell engine to reject with 409/429
   *   - Lock acquired → engine may proceed to execute handler
   */
  atomicCheckAndLock(
    key: string,
    fingerprint: string,
    lockTtlMs: number,
  ): Promise<
    | {
        status: "exists";
        fingerprint: string;
        result: unknown;
        createdAt?: string;
      }
    | { status: "locked" }
    | { status: "acquired" }
  >;

  /**
   * Commit the final result after handler execution succeeded.
   *
   * This replaces the temporary "processing" state with the actual result.
   * Must be atomic (conditional write / transaction).
   *
   * @param key - The idempotency key
   * @param fingerprint - The fingerprint that was used
   * @param result - The handler's return value (will be serialized by the adapter)
   * @param retentionMs - How long to keep the result before expiration
   */
  commitResult(
    key: string,
    fingerprint: string,
    result: unknown,
    retentionMs: number,
  ): Promise<void>;

  /**
   * Optional: Release the lock early.
   *
   * Many implementations rely on TTL expiration instead of explicit release.
   * If implemented, should be best-effort (not throwing on failure).
   */
  releaseLock?(key: string): Promise<void>;

  /**
   * Optional: Record an audit event.
   *
   * - For Postgres/MySQL: store in an immutable audit table
   * - For Redis/DynamoDB: can forward to external system (CloudWatch, ELK, etc.)
   * - Should NEVER include full result or sensitive data
   *
   * The engine will call this for every significant action.
   */
  recordAudit?(event: AuditEvent): Promise<void>;

  /**
   * Optional: Called during engine shutdown / health checks.
   * Allows adapters to clean up resources (close connections, flush buffers, etc.).
   */
  close?(): Promise<void>;
}

/**
 * Audit event shape – intentionally minimal and safe for compliance
 */
export interface AuditEvent {
  timestamp: string; // ISO 8601
  key: string; // idempotency key (not sensitive)
  action:
    | "hit" // cache hit – returned stored result
    | "miss" // no result found, proceeding
    | "acquired" // lock acquired, starting handler
    | "locked" // already processing → rejected
    | "fingerprint_mismatch" // security-relevant event
    | "stored" // result successfully committed
    | "error" // handler or internal error
    | "timeout" // handler timed out
    | "lock_released"; // lock explicitly released

  fingerprint?: string; // current request fingerprint
  storedFingerprint?: string; // only for mismatch events

  metadata?: Record<string, unknown>; // optional: requestId, clientId, ip, etc.
  // NEVER include PII, card data, full result
}
