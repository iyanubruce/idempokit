/**
 * MongoDB adapter for IdempotKit – provides idempotency with TTL-based cleanup
 * and audit trails for compliance.
 *
 * Key Features:
 * - ✅ **Atomic Operations**: Uses MongoDB's findAndModify for race condition protection
 * - ✅ **Automatic TTL Cleanup**: Results auto-expire based on retention policy
 * - ✅ **Immutable Audit Trail**: Separate collection for compliance logging
 * - ✅ **Schema Validation**: Ensures data integrity with JSON schema validation
 * - ✅ **Connection Management**: Proper connection pooling and cleanup
 *
 * Usage:
 * ```ts
 * const client = new MongoClient('mongodb://localhost:27017');
 * await client.connect();
 * const adapter = new MongoAdapter(client.db('myapp'));
 * ```
 */
import { IdempotencyStore, AuditEvent } from "@idempotkit/core";
import {
  MongoClient,
  Db,
  Collection,
  ObjectId,
  UpdateFilter,
  FindOneAndUpdateOptions,
} from "mongodb";

/**
 * MongoDB document structure for idempotency keys
 */
export interface IdempotencyKeyDoc {
  _id: string; // idempotency key
  fingerprint: string; // request fingerprint
  result: unknown; // handler result
  createdAt: Date; // creation timestamp
  expiresAt: Date; // expiration timestamp (for TTL)
  status: "processing" | "committed"; // processing state
}

/**
 * MongoDB document structure for audit events
 */
export interface AuditEventDoc {
  _id: ObjectId; // auto-generated ID
  key: string; // idempotency key
  action: AuditEvent["action"]; // audit action
  fingerprint?: string; // request fingerprint
  metadata?: Record<string, unknown>; // safe metadata
  createdAt: Date; // audit timestamp
}

/**
 * Implements the IdempotencyStore interface for MongoDB databases.
 *
 * This adapter uses MongoDB's atomic operations to ensure race condition protection
 * and leverages TTL indexes for automatic cleanup of expired records.
 */
export class MongoAdapter implements IdempotencyStore {
  private readonly keysCollection: Collection<IdempotencyKeyDoc>;
  private readonly auditCollection: Collection<AuditEventDoc>;

  /**
   * Creates a new MongoAdapter instance.
   *
   * @param db - MongoDB database instance
   * @param options - Configuration options
   * @param options.collectionPrefix - Optional prefix for collection names (default: 'idempotency')
   */
  constructor(
    private readonly db: Db,
    private readonly options: { collectionPrefix?: string } = {},
  ) {
    const prefix = options.collectionPrefix || "idempotency";
    this.keysCollection = db.collection<IdempotencyKeyDoc>(`${prefix}_keys`);
    this.auditCollection = db.collection<AuditEventDoc>(`${prefix}_audit`);

    // Ensure TTL index exists for automatic cleanup
    this.ensureIndexes();
  }

  /**
   * Ensures required indexes exist for TTL cleanup and query performance.
   *
   * - TTL index on expiresAt field for automatic document expiration
   * - Compound index on _id + status for efficient lookups
   */
  private async ensureIndexes(): Promise<void> {
    // TTL index for automatic cleanup of expired documents
    await this.keysCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );

    // Compound index for efficient lookups by key and status
    await this.keysCollection.createIndex({ _id: 1, status: 1 });

    // Index for audit trail queries
    await this.auditCollection.createIndex({ key: 1, createdAt: -1 });
  }

  /**
   * Atomically checks for an existing result or acquires a processing lock.
   *
   * Uses MongoDB's findOneAndUpdate with upsert to handle all scenarios atomically:
   * - If document exists and is committed → return existing result
   * - If document exists and is processing → return locked status
   * - If no document exists → create processing document and return acquired status
   *
   * @param key - The idempotency key
   * @param fingerprint - Request fingerprint (not used in this operation but required by interface)
   * @param lockTtlMs - How long to keep the processing document before it expires
   * @returns Status indicating next action for the core engine
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
    const now = new Date();
    const processingExpiresAt = new Date(now.getTime() + lockTtlMs);

    // Try to find existing document or create a processing one
    const result = await this.keysCollection.findOneAndUpdate(
      { _id: key },
      {
        $setOnInsert: {
          _id: key,
          status: "processing",
          expiresAt: processingExpiresAt,
          createdAt: now,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        includeResultMetadata: true,
      } as any,
    );

    if (!result.value) {
      throw new Error("Failed to create or find idempotency key document");
    }

    const doc = result.value;

    // Check if document has expired
    if (doc.expiresAt < now) {
      // Document expired, treat as new
      const newResult = await this.keysCollection.findOneAndUpdate(
        { _id: key, expiresAt: { $lt: now } },
        {
          $set: {
            status: "processing",
            expiresAt: processingExpiresAt,
            createdAt: now,
          },
        },
        { returnDocument: "after", includeResultMetadata: true } as any, // Add metadata here too
      );

      if (newResult.value) {
        return { status: "acquired" };
      } else {
        // Another operation updated it, recurse
        return this.atomicCheckAndLock(key, fingerprint, lockTtlMs);
      }
    }

    // Handle based on document status
    if (doc.status === "committed") {
      return {
        status: "exists",
        fingerprint: doc.fingerprint,
        result: doc.result,
        createdAt: doc.createdAt.toISOString(),
      };
    }

    // Status is "processing" (or unexpected)
    if (doc.status !== "processing") {
      throw new Error(`Unexpected status for key ${key}: ${doc.status}`);
    }

    const wasInserted = !!result.lastErrorObject?.upserted; // True if we created it

    if (wasInserted) {
      return { status: "acquired" };
    } else {
      // It already existed → someone else owns it
      return { status: "locked" };
    }
  }

  /**
   * Commits the final result after successful handler execution.
   *
   * Updates the processing document to committed state with the final result
   * and extends the expiration time based on retention policy.
   *
   * @param key - The idempotency key
   * @param fingerprint - Request fingerprint for future validation
   * @param result - Handler's return value
   * @param retentionMs - How long to retain the committed result
   */

  async commitResult(
    key: string,
    fingerprint: string,
    result: unknown,
    retentionMs: number,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + retentionMs);

    const update: UpdateFilter<IdempotencyKeyDoc> = {
      $set: {
        status: "committed",
        fingerprint,
        result,
        expiresAt,
        // Keep original createdAt
      },
    };

    const resultDoc = await this.keysCollection.findOneAndUpdate(
      { _id: key, status: "processing" },
      update,
      { returnDocument: "after" },
    );

    if (!resultDoc) {
      // No processing document found - might have expired or been committed already
      throw new Error(
        "Cannot commit result: no active processing document found",
      );
    }
  }

  /**
   * Records an audit event to the immutable audit trail.
   *
   * Stores audit events in a separate collection with automatic indexing
   * for compliance and forensic analysis.
   *
   * @param event - Safe audit event containing no PII or sensitive data
   */
  async recordAudit(event: AuditEvent): Promise<void> {
    const auditDoc: AuditEventDoc = {
      _id: new ObjectId(),
      key: event.key,
      action: event.action,
      fingerprint: event.fingerprint,
      metadata: event.metadata,
      createdAt: new Date(event.timestamp),
    };

    await this.auditCollection.insertOne(auditDoc);
  }

  /**
   * Releases a processing lock by deleting the processing document.
   *
   * This is a best-effort operation since MongoDB TTL will clean up expired documents anyway.
   *
   * @param key - The idempotency key to release
   */
  async releaseLock(key: string): Promise<void> {
    // Delete processing document if it exists
    await this.keysCollection.deleteOne({
      _id: key,
      status: "processing",
    });
  }

  /**
   * Cleans up database resources when the adapter is no longer needed.
   *
   * Note: This does NOT close the MongoDB client connection, only cleans up
   * any internal resources managed by the adapter.
   */
  async close(): Promise<void> {
    // MongoDB adapter doesn't maintain its own connections,
    // so nothing to clean up here
  }
}

/**
 * Helper function to set up MongoDB collections with proper validation schemas.
 *
 * This function creates JSON schema validation for the idempotency collections
 * to ensure data integrity at the database level.
 *
 * @param db - MongoDB database instance
 * @param options - Configuration options
 * @param options.collectionPrefix - Optional prefix for collection names
 */
export async function setupMongoCollections(
  db: Db,
  options?: { collectionPrefix?: string },
): Promise<void> {
  const prefix = options?.collectionPrefix || "idempotency";
  const keysCollectionName = `${prefix}_keys`;
  const auditCollectionName = `${prefix}_audit`;

  // Create validation schema for keys collection
  const keysValidator = {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "status", "expiresAt", "createdAt"],
      properties: {
        _id: { bsonType: "string" },
        fingerprint: { bsonType: "string" },
        result: { bsonType: "object" },
        status: {
          enum: ["processing", "committed"],
        },
        expiresAt: { bsonType: "date" },
        createdAt: { bsonType: "date" },
      },
    },
  };

  // Create collections with validation
  try {
    await db.createCollection(keysCollectionName, {
      validator: keysValidator,
    });
  } catch (error) {
    // Collection might already exist, that's OK
    if ((error as any).codeName !== "NamespaceExists") {
      throw error;
    }
  }

  // Audit collection doesn't need strict validation since it's append-only
  try {
    await db.createCollection(auditCollectionName);
  } catch (error) {
    if ((error as any).codeName !== "NamespaceExists") {
      throw error;
    }
  }

  console.log(
    `[IdempotKit] MongoDB collections created: ${keysCollectionName}, ${auditCollectionName}`,
  );
}
