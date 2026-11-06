import type { Db } from '../../../../shared/application/db';
import type { InboxMessage } from '../../domain/inbox-message';

export interface InboxRepository {
  /**
   * Records the message if not already seen. Must run inside the same
   * transaction as the business effect. Deduplication is enforced by the
   * composite PK (consumer_name, message_id) — the database is the source of
   * truth, never an in-memory cache.
   *
   * @returns true when the message is new (first delivery), false when it was
   * already recorded (duplicate delivery).
   */
  insertIfAbsent(message: InboxMessage, db: Db): Promise<boolean>;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
