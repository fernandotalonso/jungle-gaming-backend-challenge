import type { Db } from '../../../../../shared/application/db';
import type { OutboxRepository } from '../../../application/ports/outbox.repository';
import { OutboxMessage } from '../../../domain/outbox-message';
import { OutboxMessageEntity } from './outbox-message.entity';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

function rowToDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at,
  });
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  async insert(message: OutboxMessage, db: Db): Promise<void> {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = message.payload;
    entity.occurredAt = message.occurredAt;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;
    db.persist(entity);
    await db.flush();
  }

  async claimDue(db: Db, now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = (await db.execute(
      `SELECT * FROM outbox_messages
       WHERE published_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY next_attempt_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
      'all',
    )) as OutboxRow[];
    return rows.map(rowToDomain);
  }

  async update(message: OutboxMessage, db: Db): Promise<void> {
    await db.execute(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, published_at = ? WHERE id = ?`,
      [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
    );
  }
}
