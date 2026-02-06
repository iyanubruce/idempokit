/**
 * IdempotKit Core – Storage-agnostic idempotency primitive.
 *
 * @example
 *   import { IdempotencyEngine } from 'idempotkit';
 *   import { RedisAdapter } from '@idempotkit/redis-adapter';
 *
 *   const engine = new IdempotencyEngine(
 *     new RedisAdapter(redis),
 *     {
 *       lockTtl: 30_000,
 *       retention: 86_400_000,
 *       onAudit: (e) => auditLog.insert(e)
 *     }
 *   );
 *
 *   await engine.execute(key, engine.fingerprint(req.body), () => processPayment());
 */

export { IdempotencyEngine } from "./engine";
export type {
  IdempotencyStore,
  EngineOptions,
  ExecuteOptions,
  AuditEvent,
} from "./types";
export {
  IdempotencyError,
  InvalidIdempotencyKeyError,
  FingerprintMismatchError,
  InvalidRetentionError,
  OperationInProgressError,
  HandlerTimeoutError,
} from "./errors";
