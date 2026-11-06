import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../src/modules/messaging/domain/events/wallet-balance-changed';
import { MikroOrmInboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { LedgerDirection } from '../../src/shared/domain/ledger-direction';
import { Money } from '../../src/shared/domain/money';
import { payloadHash } from '../../src/shared/canonical-json';
import { getTestOrm, truncateAll } from '../helpers/db';
import type { Db } from '../../src/shared/application/db';

let orm: MikroORM;
let wallets: MikroOrmWalletRepository;
let ledger: MikroOrmLedgerRepository;
let transactions: MikroOrmWagerTransactionRepository;
let inbox: MikroOrmInboxRepository;
let outbox: MikroOrmOutboxRepository;
let uow: MikroOrmUnitOfWork;

const PLAYER = 'player-1';

function openWallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: crypto.randomUUID(),
    playerId: PLAYER,
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
}

function betFor(walletId: string): WagerTransaction {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    payloadHash: payloadHash({ amount: '10.00' }),
    walletId,
    playerId: PLAYER,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
  });
}

function entryToProps(entry: WalletLedgerEntry) {
    return {
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
    };
  }

  /** Seeds wallet + a PROCESSED BET so ledger entries can reference a real transaction. */
async function seedWalletWithBet(balance = '100.00'): Promise<{ wallet: Wallet; bet: WagerTransaction }> {
  const wallet = openWallet(balance);
  const bet = betFor(wallet.id);
  bet.markProcessed(undefined, new Date());
  await uow.run(async (db) => {
    await wallets.insert(wallet, db);
    await transactions.insert(bet, db);
  });
  return { wallet, bet };
}

beforeAll(async () => {
  orm = await getTestOrm();
  wallets = new MikroOrmWalletRepository(orm);
  ledger = new MikroOrmLedgerRepository(orm);
  transactions = new MikroOrmWagerTransactionRepository(orm);
  inbox = new MikroOrmInboxRepository();
  outbox = new MikroOrmOutboxRepository();
  uow = new MikroOrmUnitOfWork(orm);
});

beforeEach(async () => {
  await truncateAll(orm);
});

describe('WalletRepository', () => {
  it('round-trips a wallet through insert and findById', async () => {
    const wallet = openWallet('42.42');
    await uow.run(async (db) => wallets.insert(wallet, db));

    const loaded = await wallets.findById(wallet.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.balance.toString()).toBe('42.42');
    expect(loaded!.version).toBe(1);
    expect(loaded!.currency).toBe('BRL');
    expect(loaded!.createdAt.getTime()).toBe(wallet.createdAt.getTime());
  });

  it('returns null for unknown ids', async () => {
    expect(await wallets.findById(crypto.randomUUID())).toBeNull();
  });

  it('findByIdForUpdate serializes concurrent writers on the same wallet', async () => {
    const wallet = openWallet('100.00');
    await uow.run(async (db) => wallets.insert(wallet, db));

    // tx A locks the wallet and sleeps before committing its debit
    const txA = uow.run(async (db) => {
      const locked = await wallets.findByIdForUpdate(wallet.id, db);
      locked!.debit('tx-a', Money.from({ amount: '10.00', currency: 'BRL' }));
      // the debit already bumped balance/version in the aggregate; persist via update
      await db.execute('UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ?', [
        locked!.balance.toString(),
        locked!.version,
        locked!.updatedAt,
        wallet.id,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return locked!.balance.toString();
    });

    // tx B must wait for the lock, then observe A's committed state
    await new Promise((resolve) => setTimeout(resolve, 30));
    const txBStart = Date.now();
    const balanceB = await uow.run(async (db) => {
      const locked = await wallets.findByIdForUpdate(wallet.id, db);
      return locked!.balance.toString();
    });

    await txA;
    expect(balanceB).toBe('90.00'); // B read AFTER A committed (lock order)
    expect(Date.now() - txBStart).toBeGreaterThanOrEqual(100); // B actually waited
  });
});

describe('LedgerRepository', () => {
  it('inserts and lists entries in chronological order with cursor pagination', async () => {
    // each movement is its own transaction (one entry per transaction per wallet)
    const wallet = openWallet();
    const bets = Array.from({ length: 5 }, () => {
      const bet = betFor(wallet.id);
      bet.markProcessed(undefined, new Date());
      return bet;
    });
    await uow.run(async (db) => {
      await wallets.insert(wallet, db);
      for (const bet of bets) {
        await transactions.insert(bet, db);
      }
    });

    const entries: WalletLedgerEntry[] = [];
    for (let i = 0; i < 5; i++) {
      const entry = wallet.credit(bets[i]!.id, Money.from({ amount: '1.00', currency: 'BRL' }), new Date(2026, 0, i + 1));
      entries.push(entry);
      await uow.run(async (db) => ledger.insert(entry, db));
    }

    const page1 = await ledger.listByWalletId(wallet.id, { limit: 2 });
    expect(page1.items.map((entry) => entry.transactionId)).toEqual([
      entries[0]!.transactionId,
      entries[1]!.transactionId,
    ]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await ledger.listByWalletId(wallet.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((entry) => entry.transactionId)).toEqual([
      entries[2]!.transactionId,
      entries[3]!.transactionId,
    ]);

    const page3 = await ledger.listByWalletId(wallet.id, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((entry) => entry.transactionId)).toEqual([entries[4]!.transactionId]);
    expect(page3.nextCursor).toBeNull();
  });

  it('persists exact numeric strings (no float drift)', async () => {
    const { wallet, bet } = await seedWalletWithBet('0.01');
    const entry = wallet.credit(bet.id, Money.from({ amount: '999999999999.98', currency: 'BRL' }));
    await uow.run(async (db) => ledger.insert(entry, db));

    const loaded = await ledger.listByWalletId(wallet.id, { limit: 10 });
    expect(loaded.items[0]!.money.toString()).toBe('999999999999.98');
    expect(loaded.items[0]!.balanceAfter.toString()).toBe('999999999999.99');
  });
});

describe('WagerTransactionRepository', () => {
  it('round-trips insert/find/update of state transitions', async () => {
    const wallet = openWallet();
    const bet = betFor(wallet.id);
    await uow.run(async (db) => {
      await wallets.insert(wallet, db);
      await transactions.insert(bet, db);
    });

    const loaded = await transactions.findByIdempotencyKey(bet.idempotencyKey);
    expect(loaded!.status).toBe(WagerTransactionStatus.Pending);

    loaded!.markProcessed(undefined, new Date());
    await uow.run(async (db) => transactions.update(loaded!, db));

    const afterUpdate = await transactions.findByProviderAndExternalId(
      bet.providerId,
      bet.externalTransactionId,
    );
    expect(afterUpdate!.status).toBe(WagerTransactionStatus.Processed);
    expect(afterUpdate!.processedAt).not.toBeUndefined();
    expect(await transactions.findById(bet.id)).not.toBeNull();
  });

  it('persists pending-reference retry state', async () => {
    const wallet = openWallet();
    const refund = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      idempotencyKey: `key-${crypto.randomUUID()}`,
      payloadHash: payloadHash({}),
      walletId: wallet.id,
      playerId: PLAYER,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'missing-ref',
    });
    refund.markPendingReference();
    refund.scheduleReferenceCheck(new Date('2026-01-01T00:00:00Z'));

    await uow.run(async (db) => {
      await wallets.insert(wallet, db);
      await transactions.insert(refund, db);
    });

    const due = await uow.run(async (db) =>
      transactions.findPendingReferences(db, new Date('2026-01-01T00:00:01Z'), 10),
    );
    expect(due.map((tx) => tx.id)).toContain(refund.id);

    const beforeDue = await uow.run(async (db) =>
      transactions.findPendingReferences(db, new Date('2026-01-01T00:00:00.5Z'), 10),
    );
    expect(beforeDue.map((tx) => tx.id)).not.toContain(refund.id);
  });
});

describe('InboxRepository', () => {
  it('deduplicates by (consumerName, messageId)', async () => {
    const message = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'consumer-1', payloadHash: 'e'.repeat(64) });

    const first = await uow.run(async (db) => inbox.insertIfAbsent(message, db));
    expect(first).toBe(true);

    const duplicate = await uow.run(async (db) => inbox.insertIfAbsent(message, db));
    expect(duplicate).toBe(false);
  });
});

describe('OutboxRepository', () => {
  function makeOutboxMessage(): OutboxMessage {
    const event = WalletBalanceChanged.from(
      { id: crypto.randomUUID(), version: 2 },
      {
        transactionId: crypto.randomUUID(),
        direction: LedgerDirection.Credit,
        money: { amount: '5.00', currency: 'BRL' },
        balanceBefore: { amount: '10.00', currency: 'BRL' },
        balanceAfter: { amount: '15.00', currency: 'BRL' },
      },
      { correlationId: 'corr-1' },
    );
    return OutboxMessage.enqueue(event);
  }

  it('claims due messages without overlap across concurrent transactions (SKIP LOCKED)', async () => {
    await uow.run(async (db) => {
      for (let i = 0; i < 4; i++) {
        await outbox.insert(makeOutboxMessage(), db);
      }
    });

    const tx1Claims = uow.run(async (db) => {
      const claimed = await outbox.claimDue(db, new Date(), 10);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return claimed.map((message) => message.id);
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const tx2Claims = await uow.run(async (db) => outbox.claimDue(db, new Date(), 10));

    const tx1 = await tx1Claims;
    // tx2 saw nothing: everything was locked by tx1
    expect(tx1).toHaveLength(4);
    expect(tx2Claims).toHaveLength(0);
  });

  it('update persists publication state', async () => {
    const message = makeOutboxMessage();
    await uow.run(async (db) => outbox.insert(message, db));

    message.markPublished(new Date());
    await uow.run(async (db) => outbox.update(message, db));

    const claimed = await uow.run(async (db) => outbox.claimDue(db, new Date(), 10));
    expect(claimed).toHaveLength(0); // published, no longer due
  });
});

describe('UnitOfWork atomicity', () => {
  it('rolls back every write when the use case throws', async () => {
    const wallet = openWallet();
    const bet = betFor(wallet.id);

    await expect(
      uow.run(async (db) => {
        await wallets.insert(wallet, db);
        await transactions.insert(bet, db);
        const entry = wallet.credit(bet.id, Money.from({ amount: '10.00', currency: 'BRL' }));
        await ledger.insert(entry, db);
        await outbox.insert(OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entryToProps(entry), { correlationId: 'corr-1' }),
        ), db);
        throw new Error('boom — simulate crash before commit');
      }),
    ).rejects.toThrow('boom');

    expect(await wallets.findById(wallet.id)).toBeNull();
    const ledgerPage = await ledger.listByWalletId(wallet.id, { limit: 10 });
    expect(ledgerPage.items).toHaveLength(0);
    const rows = await (orm.em as Db).execute<Array<{ count: string }>>('SELECT count(*) AS count FROM outbox_messages');
    expect(rows[0]!.count).toBe('0');
  });

  it('commits everything together on success', async () => {
    const wallet = openWallet();
    const bet = betFor(wallet.id);

    await uow.run(async (db) => {
      await wallets.insert(wallet, db);
      await transactions.insert(bet, db);
      const entry = wallet.credit(bet.id, Money.from({ amount: '10.00', currency: 'BRL' }));
      await wallets.update(wallet, db);
      await ledger.insert(entry, db);
      await inbox.insertIfAbsent(
        InboxMessage.receive({ messageId: 'msg-1', consumerName: 'consumer-1', payloadHash: 'f'.repeat(64) }),
        db,
      );
      await outbox.insert(OutboxMessage.enqueue(
        WalletBalanceChanged.from(wallet, entryToProps(entry), { correlationId: 'corr-1' }),
      ), db);
    });

    const loaded = await wallets.findById(wallet.id);
    expect(loaded!.balance.toString()).toBe('110.00');
    expect((await ledger.listByWalletId(wallet.id, { limit: 10 })).items).toHaveLength(1);
    const outboxRows = await (orm.em as Db).execute<Array<{ count: string }>>('SELECT count(*) AS count FROM outbox_messages');
    expect(outboxRows[0]!.count).toBe('1');
    const inboxRows = await (orm.em as Db).execute<Array<{ count: string }>>('SELECT count(*) AS count FROM inbox_messages');
    expect(inboxRows[0]!.count).toBe('1');
  });
});
