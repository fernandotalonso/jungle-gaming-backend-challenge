import type { MikroORM } from '@mikro-orm/core';
import type { Db } from '../../../../../shared/application/db';
import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository';
import { WagerTransaction } from '../../../domain/wager-transaction';
import { WagerTransactionStatus } from '../../../domain/wager-transaction';
import { WagerTransactionEntity } from './wager-transaction.entity';

interface WagerTxRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  reference_attempts: number;
  next_reference_check_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
}

function rowToDomain(row: WagerTxRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: { amount: row.amount, currency: row.currency },
    referenceExternalTransactionId: row.reference_external_transaction_id,
    createdAt: row.created_at,
    status: row.status,
    referenceTransactionId: row.reference_transaction_id,
    failureCode: row.failure_code,
    processedAt: row.processed_at,
    referenceAttempts: row.reference_attempts,
    nextReferenceCheckAt: row.next_reference_check_at,
  });
}

function toDomain(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: { amount: entity.amount, currency: entity.currency },
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    createdAt: entity.createdAt,
    status: entity.status,
    referenceTransactionId: entity.referenceTransactionId,
    failureCode: entity.failureCode,
    processedAt: entity.processedAt,
    referenceAttempts: entity.referenceAttempts,
    nextReferenceCheckAt: entity.nextReferenceCheckAt,
  });
}

function toEntity(tx: WagerTransaction, entity: WagerTransactionEntity = new WagerTransactionEntity()): WagerTransactionEntity {
  entity.id = tx.id;
  entity.providerId = tx.providerId;
  entity.externalTransactionId = tx.externalTransactionId;
  entity.idempotencyKey = tx.idempotencyKey;
  entity.payloadHash = tx.payloadHash;
  entity.walletId = tx.walletId;
  entity.playerId = tx.playerId;
  entity.roundId = tx.roundId;
  entity.gameId = tx.gameId;
  entity.kind = tx.kind;
  entity.amount = tx.money.toString();
  entity.currency = tx.money.currency;
  entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  entity.referenceTransactionId = tx.referenceTransactionId;
  entity.status = tx.status;
  entity.failureCode = tx.failureCode;
  entity.referenceAttempts = tx.referenceAttempts;
  entity.nextReferenceCheckAt = tx.nextReferenceCheckAt;
  entity.createdAt = tx.createdAt;
  entity.processedAt = tx.processedAt;
  return entity;
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly orm: MikroORM) {}

  async insert(tx: WagerTransaction, db: Db): Promise<void> {
    db.persist(toEntity(tx));
    // explicit flush: guarantees the wallet row exists before the FK check
    await db.flush();
  }

  async update(tx: WagerTransaction, db: Db): Promise<void> {
    // full-row update of mutable state; the row was locked by the use case
    await db.execute(
      `UPDATE wager_transactions SET
         status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ?,
         reference_attempts = ?, next_reference_check_at = ?
       WHERE id = ?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.processedAt ?? null,
        tx.referenceAttempts,
        tx.nextReferenceCheckAt ?? null,
        tx.id,
      ],
    );
  }

  async findById(id: string, db?: Db): Promise<WagerTransaction | null> {
    const entity = await (db ?? this.orm.em.fork()).findOne(WagerTransactionEntity, { id });
    return entity ? toDomain(entity) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string, db?: Db): Promise<WagerTransaction | null> {
    const entity = await (db ?? this.orm.em.fork()).findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    db?: Db,
  ): Promise<WagerTransaction | null> {
    const entity = await (db ?? this.orm.em.fork()).findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return entity ? toDomain(entity) : null;
  }

  async findPendingReferences(db: Db, now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = (await db.execute(
      `SELECT * FROM wager_transactions
       WHERE status = ?
         AND (next_reference_check_at IS NULL OR next_reference_check_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [WagerTransactionStatus.PendingReference, now, limit],
      'all',
    )) as WagerTxRow[];
    return rows.map(rowToDomain);
  }

  async findProcessedReversalFor(referenceTransactionId: string, db?: Db): Promise<WagerTransaction | null> {
    const manager: Db = db ?? (this.orm.em.fork() as Db);
    const rows = (await manager.execute(
      `SELECT * FROM wager_transactions
       WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
       LIMIT 1`,
      [referenceTransactionId],
      'all',
    )) as WagerTxRow[];
    return rows.length > 0 ? rowToDomain(rows[0]!) : null;
  }
}
