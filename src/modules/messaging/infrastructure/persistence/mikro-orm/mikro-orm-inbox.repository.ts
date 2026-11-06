import type { Db } from '../../../../../shared/application/db';
import type { InboxRepository } from '../../../application/ports/inbox.repository';
import type { InboxMessage } from '../../../domain/inbox-message';

export class MikroOrmInboxRepository implements InboxRepository {
  async insertIfAbsent(message: InboxMessage, db: Db): Promise<boolean> {
    const result = (await db.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'all',
    )) as Array<{ message_id: string }>;
    return Array.isArray(result) && result.length > 0;
  }
}
