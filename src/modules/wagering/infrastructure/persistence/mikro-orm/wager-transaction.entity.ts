import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Persistence model for WagerTransaction. All business rules live in the
 * domain aggregate; this class only mirrors persisted state.
 */
@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ fieldName: 'id', columnType: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', columnType: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id' })
  playerId!: string;

  @Property({ fieldName: 'round_id' })
  roundId!: string;

  @Property({ fieldName: 'game_id' })
  gameId!: string;

  @Property({ fieldName: 'kind' })
  kind!: string; // OPENING | BET | WIN | LOSS | REFUND | ROLLBACK

  @Property({ fieldName: 'amount', columnType: 'numeric(14,2)' })
  amount!: string;

  @Property({ fieldName: 'currency' })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: 'reference_transaction_id', columnType: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ fieldName: 'status' })
  status!: string; // PENDING | PENDING_REFERENCE | PROCESSED | REJECTED | FAILED

  @Property({ fieldName: 'failure_code', nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'reference_attempts' })
  referenceAttempts!: number;

  @Property({ fieldName: 'next_reference_check_at', columnType: 'timestamptz', nullable: true })
  nextReferenceCheckAt?: Date;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
