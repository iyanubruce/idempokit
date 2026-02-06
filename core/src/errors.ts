/**
 * Base class for all idempotency-related errors
 */

export class IdempotencyError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "IdempotencyError";
    this.status = status;
    this.code = code;

    // Maintain proper stack trace in Node.js
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Thrown when the idempotency key is missing, empty, or invalid
 * → usually HTTP 400 Bad Request
 */
export class InvalidIdempotencyKeyError extends IdempotencyError {
  constructor(message = "Idempotency key is required and must not be empty") {
    super(message, 400, "IDEMPOTENCY_KEY_REQUIRED");
    this.name = "InvalidIdempotencyKeyError";
  }
}

/**
 * Thrown when the provided fingerprint does not match the stored one
 * → indicates possible replay attack or tampered payload
 * → usually HTTP 422 Unprocessable Entity
 */
export class FingerprintMismatchError extends IdempotencyError {
  constructor(
    message = "Fingerprint mismatch - request payload does not match previous execution",
    public readonly storedFingerprint?: string,
  ) {
    super(message, 422, "FINGERPRINT_MISMATCH");
    this.name = "FingerprintMismatchError";
  }
}

/**
 * Thrown when another request with the same idempotency key is already in progress
 * → usually HTTP 409 Conflict or 429 Too Many Requests (your choice)
 */
export class OperationInProgressError extends IdempotencyError {
  constructor(
    message = "Operation with this idempotency key is already being processed",
  ) {
    super(message, 409, "OPERATION_IN_PROGRESS");
    this.name = "OperationInProgressError";
  }
}

/**
 * Thrown when the engine cannot acquire a lock (e.g. store is unavailable, timeout, etc.)
 * → usually HTTP 503 Service Unavailable or 500
 */
export class LockAcquisitionError extends IdempotencyError {
  constructor(message = "Failed to acquire lock - please try again later") {
    super(message, 503, "LOCK_ACQUISITION_FAILED");
    this.name = "LockAcquisitionError";
  }
}

/**
 * Thrown when retention period is invalid (too short for compliance)
 * → usually thrown at engine initialization or when override is used
 * → HTTP 400 or 500 depending on context
 */
export class InvalidRetentionError extends IdempotencyError {
  constructor(
    message = "Retention period must be at least 24 hours (86400000 ms) for compliance",
  ) {
    super(message, 400, "INVALID_RETENTION_PERIOD");
    this.name = "InvalidRetentionError";
  }
}

export class onAuditRequiredError extends IdempotencyError {
  constructor(message = "On Audit is required") {
    super(message, 400, "ON-AUDIT_NOT_PASSED");
    this.name = "NoOnAuditError";
  }
}
/**
 * Generic internal error (storage failure, serialization error, unexpected bug, etc.)
 * → usually HTTP 500
 */
export class IdempotencyInternalError extends IdempotencyError {
  constructor(message = "Internal idempotency error", originalError?: unknown) {
    super(message, 500, "INTERNAL_ERROR");
    this.name = "IdempotencyInternalError";
    if (originalError) {
      this.cause = originalError;
    }
  }
}

export class HandlerTimeoutError extends IdempotencyError {
  constructor(message = "Handler execution exceeded timeout") {
    super(message, 503, "HANDLER_TIMEOUT");
    this.name = "HandlerTimeoutError";
  }
}
