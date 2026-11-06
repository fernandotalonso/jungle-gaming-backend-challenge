import type { Db } from '../../../../shared/application/db';
import type { OutboxMessage } from '../../domain/outbox-message';

export interface OutboxRepository {
  /** Must run inside an active transaction (same tx as the business effect). */
  insert(message: OutboxMessage, db: Db): Promise<void>;
  /**
   * Claims due, unpublished messages with FOR UPDATE SKIP LOCKED — safe with
   * concurrent publishers on multiple instances. Must run inside a transaction.
   */
  claimDue(db: Db, now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists publication state (attempts / nextAttemptAt / publishedAt). Must run inside a transaction. */
  update(message: OutboxMessage, db: Db): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
