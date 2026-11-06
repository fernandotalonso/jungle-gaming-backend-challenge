import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Persistence model for the transactional outbox. `payload` is the serialized
 * integration event envelope (stable, versioned JSON).
 */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ fieldName: 'id', columnType: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type' })
  eventType!: string;

  @Property({ fieldName: 'payload', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ fieldName: 'attempts' })
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'published_at', columnType: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
