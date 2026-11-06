import type { MikroORM } from '@mikro-orm/core';
import { decodeCursor, encodeCursor } from '../../../../../shared/cursor';
import type { Db } from '../../../../../shared/application/db';
import type { LedgerPage, LedgerRepository, ListLedgerOptions } from '../../../application/ports/ledger.repository';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { LedgerDirection } from '../../../../../shared/domain/ledger-direction';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

function rowToDomain(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: { amount: row.amount, currency: row.currency },
    balanceBefore: { amount: row.balance_before, currency: row.currency },
    balanceAfter: { amount: row.balance_after, currency: row.currency },
    createdAt: row.created_at,
  });
}

function entityToDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.walletId,
    transactionId: entity.transactionId,
    direction: entity.direction as LedgerDirection,
    money: { amount: entity.amount, currency: entity.currency },
    balanceBefore: { amount: entity.balanceBefore, currency: entity.currency },
    balanceAfter: { amount: entity.balanceAfter, currency: entity.currency },
    createdAt: entity.createdAt,
  });
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly orm: MikroORM) {}

  async insert(entry: WalletLedgerEntry, db: Db): Promise<void> {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toString();
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.toString();
    entity.balanceAfter = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    db.persist(entity);
    // explicit flush: guarantees wallet/transaction rows exist before the FK check
    await db.flush();
  }

  async listByWalletId(    walletId: string,
    options: ListLedgerOptions,
    db?: Db,
  ): Promise<LedgerPage> {
    const manager: Db = db ?? (this.orm.em.fork() as Db);
    const limit = Math.max(1, Math.min(options.limit, 200));

    let rows: LedgerRow[];
    if (options.cursor !== undefined) {
      const cursor = decodeCursor(options.cursor);
      rows = (await manager.execute(
        `SELECT * FROM wallet_ledger_entries
         WHERE wallet_id = ? AND (created_at, id) > (?, ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
        [walletId, cursor.createdAt, cursor.id, limit + 1],
        'all',
      )) as LedgerRow[];
    } else {
      rows = (await manager.execute(
        `SELECT * FROM wallet_ledger_entries
         WHERE wallet_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
        [walletId, limit + 1],
        'all',
      )) as LedgerRow[];
    }

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToDomain);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async findByTransactionId(transactionId: string, db?: Db): Promise<WalletLedgerEntry | null> {
    const manager: Db = db ?? (this.orm.em.fork() as Db);
    const rows = (await manager.execute(
      'SELECT * FROM wallet_ledger_entries WHERE transaction_id = ? LIMIT 1',
      [transactionId],
      'all',
    )) as LedgerRow[];
    return rows.length > 0 ? rowToDomain(rows[0]!) : null;
  }

  async findFirstEntryAfter(walletId: string, at: Date, db?: Db): Promise<WalletLedgerEntry | null> {
    const manager: Db = db ?? (this.orm.em.fork() as Db);
    const rows = (await manager.execute(
      `SELECT * FROM wallet_ledger_entries
       WHERE wallet_id = ? AND created_at >= ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [walletId, at],
      'all',
    )) as LedgerRow[];
    return rows.length > 0 ? rowToDomain(rows[0]!) : null;
  }
}

export { entityToDomain };
