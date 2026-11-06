import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Persistence model for the consumer inbox. Composite primary key
 * (consumer_name, message_id) makes the deduplication guarantee database-level.
 */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id' })
  messageId!: string;

  @Property({ fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
