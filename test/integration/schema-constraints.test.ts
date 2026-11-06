import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { getTestOrm, truncateAll } from '../helpers/db';
import type { Db } from '../../src/shared/application/db';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

beforeEach(async () => {
  await truncateAll(orm);
});

describe('schema: migrations applied', () => {
  it('has all expected tables', async () => {
    const rows: Array<{ tablename: string }> = await (orm.em as Db).execute<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const tables = rows.map((row) => row.tablename);
    for (const table of [
      'wallets',
      'wager_transactions',
      'wallet_ledger_entries',
      'inbox_messages',
      'outbox_messages',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('has the append-only trigger on the ledger', async () => {
    const rows: Array<{ tgname: string }> = await (orm.em as Db).execute<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'wallet_ledger_entries'::regclass AND NOT tgisinternal`,
    );
    expect(rows.map((row) => row.tgname)).toContain('trg_wallet_ledger_entries_append_only');
  });
});

describe('schema: wallets constraints', () => {
  it('rejects negative balance', async () => {
    const id = crypto.randomUUID();
    expect(
      (orm.em as Db).execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, 'p1', 'BRL', -1.00, 1, now(), now())`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it('rejects duplicate player_id + currency', async () => {
    const insert = (id: string) =>
      (orm.em as Db).execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, 'player-1', 'BRL', 10.00, 1, now(), now())`,
        [id],
      );
    await insert(crypto.randomUUID());
    await expect(insert(crypto.randomUUID())).rejects.toThrow();
  });

  it('allows the same player with different currencies (multi-currency model)', async () => {
    await (orm.em as Db).execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, 'player-2', 'BRL', 10.00, 1, now(), now())`,
      [crypto.randomUUID()],
    );
    await (orm.em as Db).execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, 'player-2', 'USD', 10.00, 1, now(), now())`,
      [crypto.randomUUID()],
    );
  });
});

describe('schema: wager_transactions constraints', () => {
  async function insertWallet(id: string): Promise<void> {
    await (orm.em as Db).execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', 100.00, 1, now(), now())`,
      [id, `player-3-${crypto.randomUUID()}`],
    );
  }

  async function insertTx(overrides: Record<string, string> = {}): Promise<void> {
    const walletId = crypto.randomUUID();
    await insertWallet(walletId);
    const columns: Record<string, string | Date> = {
      id: crypto.randomUUID(),
      provider_id: 'provider-a',
      external_transaction_id: `ext-${crypto.randomUUID()}`,
      idempotency_key: `key-${crypto.randomUUID()}`,
      payload_hash: 'a'.repeat(64),
      wallet_id: walletId,
      player_id: `player-3-${crypto.randomUUID()}`,
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'BET',
      amount: '10.00',
      currency: 'BRL',
      status: 'PENDING',
      created_at: new Date(),
      ...overrides,
    };
    const keys = Object.keys(columns);
    const placeholders = keys.map(() => '?').join(', ');
    await (orm.em as Db).execute(
      `INSERT INTO wager_transactions (${keys.join(', ')}) VALUES (${placeholders})`,
      Object.values(columns),
    );
  }

  it('rejects duplicate idempotency_key', async () => {
    await insertTx({ idempotency_key: 'dup-key' });
    await expect(insertTx({ idempotency_key: 'dup-key' })).rejects.toThrow();
  });

  it('rejects duplicate (provider_id, external_transaction_id)', async () => {
    await insertTx({ external_transaction_id: 'same-ext' });
    await expect(insertTx({ external_transaction_id: 'same-ext' })).rejects.toThrow();
  });

  it('rejects invalid kind and status', async () => {
    await expect(insertTx({ kind: 'DEPOSIT' })).rejects.toThrow();
    await expect(insertTx({ status: 'MAYBE' })).rejects.toThrow();
  });

  it('rejects zero and negative amounts', async () => {
    await expect(insertTx({ amount: '0.00' })).rejects.toThrow();
    await expect(insertTx({ amount: '-1.00' })).rejects.toThrow();
  });

  it('requires failure_code for REJECTED and FAILED', async () => {
    await expect(insertTx({ status: 'REJECTED' })).rejects.toThrow();
    await expect(insertTx({ status: 'FAILED' })).rejects.toThrow();
    await insertTx({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  it('requires resolved reference for PROCESSED reversals', async () => {
    // PROCESSED REFUND without resolved internal reference must fail
    await expect(
      insertTx({
        kind: 'REFUND',
        status: 'PROCESSED',
        reference_external_transaction_id: 'ext-x',
      }),
    ).rejects.toThrow();

    // proper path: create the PROCESSED BET, then a PROCESSED REFUND pointing to it
    const walletId = crypto.randomUUID();
    await insertWallet(walletId);
    const betId = crypto.randomUUID();
    await (orm.em as Db).execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES (?, 'provider-a', 'bet-ext', 'bet-key', ?, ?, 'player-3', 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PROCESSED', now())`,
      [betId, 'h'.repeat(64), walletId],
    );
    await (orm.em as Db).execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, created_at)
       VALUES (?, 'provider-a', 'refund-ext', 'refund-key', ?, ?, 'player-3', 'round-1', 'game-1', 'REFUND', '10.00', 'BRL', 'bet-ext', ?, 'PROCESSED', now())`,
      [crypto.randomUUID(), 'h'.repeat(64), walletId, betId],
    );
  });
});

describe('schema: wallet_ledger_entries constraints', () => {
  async function seedWalletAndTx(): Promise<{ walletId: string; txId: string }> {
    const walletId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    await (orm.em as Db).execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, 'player-4', 'BRL', 100.00, 1, now(), now())`,
      [walletId],
    );
    await (orm.em as Db).execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES (?, 'provider-a', ?, ?, ?, ?, 'player-4', 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PROCESSED', now())`,
      [txId, `ext-${txId}`, `key-${txId}`, 'c'.repeat(64), walletId],
    );
    return { walletId, txId };
  }

  async function insertEntry(
    walletId: string,
    txId: string,
    overrides: Record<string, string> = {},
  ): Promise<void> {
    const columns: Record<string, string | Date> = {
      id: crypto.randomUUID(),
      wallet_id: walletId,
      transaction_id: txId,
      direction: 'DEBIT',
      amount: '10.00',
      currency: 'BRL',
      balance_before: '100.00',
      balance_after: '90.00',
      created_at: new Date(),
      ...overrides,
    };
    const keys = Object.keys(columns);
    await (orm.em as Db).execute(
      `INSERT INTO wallet_ledger_entries (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      Object.values(columns),
    );
  }

  it('rejects unbalanced entries (arithmetic CHECK)', async () => {
    const { walletId, txId } = await seedWalletAndTx();
    // 100 - 10 must be 90, not 80
    await expect(insertEntry(walletId, txId, { balance_after: '80.00' })).rejects.toThrow();
  });

  it('rejects one transaction producing two entries on the same wallet', async () => {
    const { walletId, txId } = await seedWalletAndTx();
    await insertEntry(walletId, txId);
    await expect(insertEntry(walletId, txId)).rejects.toThrow();
  });

  it('rejects invalid direction', async () => {
    const { walletId, txId } = await seedWalletAndTx();
    await expect(insertEntry(walletId, txId, { direction: 'UP' })).rejects.toThrow();
  });

  it('blocks UPDATE on ledger entries (append-only trigger)', async () => {
    const { walletId, txId } = await seedWalletAndTx();
    await insertEntry(walletId, txId);
    await expect(
      (orm.em as Db).execute('UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = ?', [walletId]),
    ).rejects.toThrow(/append-only/);
  });

  it('blocks DELETE on ledger entries (append-only trigger)', async () => {
    const { walletId, txId } = await seedWalletAndTx();
    await insertEntry(walletId, txId);
    await expect(
      (orm.em as Db).execute('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('schema: inbox_messages constraints', () => {
  it('rejects duplicate (consumer_name, message_id)', async () => {
    const insert = () =>
      (orm.em as Db).execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES ('consumer-1', 'msg-1', ?, now())`,
        ['d'.repeat(64)],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});
