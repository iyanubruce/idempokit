import { IdempotencyStore } from "@idempotkit/core";
import { Redis } from "ioredis";
import { CHECK_AND_LOCK, COMMIT_RESULT } from "./lua";

/**
 * Redis implementation of the IdempotencyStore interface.
 *
 * Uses atomic Lua scripts to ensure race-condition-free idempotency:
 * - Prevents duplicate execution of the same operation
 * - Handles lock acquisition and result storage safely
 * - Recovers gracefully from Redis crashes/corruption
 *
 * ⚠️ Requires Redis 2.6+ (for Lua scripting support).
 */
export class RedisAdapter implements IdempotencyStore {
  /**
   * Create a new Redis adapter.
   *
   * @param redis - Configured ioredis client instance
   *
   * @example
   *   const redis = new Redis(process.env.REDIS_URL);
   *   const adapter = new RedisAdapter(redis);
   */
  constructor(private redis: Redis) {}

  /**
   * Atomically check for an existing result OR acquire a processing lock.
   *
   * This is the core concurrency control mechanism:
   * - If no operation exists → acquires lock (`status: "acquired"`)
   * - If operation is in progress → rejects (`status: "locked"`)
   * - If result already exists → returns it (`status: "exists"`)
   *
   * @param key - Full idempotency key (e.g., "idemp:abc123")
   * @param fingerprint - Current request's payload fingerprint (used later for validation)
   * @param lockTtlMs - How long to hold the lock if acquired (milliseconds)
   *
   * @returns One of three states:
   *   - `{ status: "acquired" }` → Proceed with handler execution
   *   - `{ status: "locked" }` → Operation in progress (retry later)
   *   - `{ status: "exists", ... }` → Return cached result
   *
   * @throws Error if Redis connection fails or Lua script errors
   */
  async atomicCheckAndLock(
    key: string,
    fingerprint: string,
    lockTtlMs: number,
  ): Promise<
    | {
        status: "exists";
        fingerprint: string;
        result: unknown;
        createdAt: string;
      }
    | { status: "locked" }
    | { status: "acquired" }
  > {
    try {
      const result = await this.redis.eval(
        CHECK_AND_LOCK,
        1, // Number of keys
        key, // KEYS[1]
        lockTtlMs.toString(), // ARGV[1] (Lua converts to number)
        new Date().toISOString(), // ARGV[2] (timestamp)
      );

      return JSON.parse(result as string);
    } catch (error) {
      console.error("Redis atomicCheckAndLock failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Idempotency store error: ${errorMessage}`);
    }
  }

  /**
   * Commit a successful result to storage with retention policy.
   *
   * Replaces the temporary "processing" state with the final result.
   * Only succeeds if the caller still holds the lock.
   *
   * @param key - Idempotency key
   * @param fingerprint - Fingerprint of the request that produced this result
   * @param result - Handler's return value (will be serialized to JSON)
   * @param retentionMs - How long to keep the result before expiration (≥24h recommended)
   *
   * @throws Error if:
   *   - Lock was lost (expired or stolen)
   *   - Result was already committed
   *   - Redis connection fails
   */
  async commitResult(
    key: string,
    fingerprint: string,
    result: unknown,
    retentionMs: number,
  ) {
    try {
      const resultJson = JSON.stringify(result);

      const success = await this.redis.eval(
        COMMIT_RESULT,
        1, // Number of keys
        key, // KEYS[1]
        fingerprint, // ARGV[1]
        resultJson, // ARGV[2] (stringified JSON)
        retentionMs.toString(), // ARGV[3]
        new Date().toISOString(), // ARGV[4]
      );

      if (success === 0) {
        throw new Error(
          "Failed to commit result: lock expired or already committed",
        );
      }
    } catch (error) {
      console.error("Redis commitResult failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Idempotency store error: ${errorMessage}`);
    }
  }

  /**
   * Release a processing lock early (best-effort).
   *
   * Typically not needed since locks auto-expire via TTL,
   * but useful for immediate cleanup after errors.
   *
   * @param key - Idempotency key to unlock
   *
   * @note Never throws – failures are silently ignored
   */
  async releaseLock(key: string) {
    await this.redis.unlink(key).catch(() => {
      // Ignore errors – TTL will clean up eventually
    });
  }
}
