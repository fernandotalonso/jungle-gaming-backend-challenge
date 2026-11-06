import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import type { Db } from '../../src/shared/application/db';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/reconcile-wallet.use-case';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../src/modules/wallets/application/wallet-errors';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/shared/domain/ledger-direction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { getTestOrm, truncateAll } from '../helpers/db';

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let reconcile: ReconcileWalletUseCase;
let transactions: MikroOrmWagerTransactionRepository;
let outbox: MikroOrmOutboxRepository;
let ledger: MikroOrmLedgerRepository;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  orm = await getTestOrm();
  const wallets = new MikroOrmWalletRepository(orm);
  ledger = new MikroOrmLedgerRepository(orm);
  transactions = new MikroOrmWagerTransactionRepository(orm);
  outbox = new MikroOrmOutboxRepository();
  uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWalletUseCase({ uow, wallets, transactions, ledger, outbox });
  reconcile = new ReconcileWalletUseCase({ wallets, ledger });
});

beforeEach(async () => {
  await truncateAll(orm);
});

describe('CreateWalletUseCase', () => {
  it('creates wallet with OPENING transaction, CREDIT entry and events in one shot', async () => {
    const { wallet } = await createWallet.execute({
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }),
    });

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);

    const loaded = await uow.run(async (db) => {
      const w = await db.execute<Array<{ balance: string; version: number }>>(
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
        'all',
      );
      return w[0]!;
    });
    expect(loaded.balance).toBe('1000.00');

    const page = await ledger.listByWalletId(wallet.id, { limit: 10 });
    expect(page.items).toHaveLength(1);
    const first = page.items[0]!;
    expect(first.direction).toBe(LedgerDirection.Credit);
    expect(first.balanceAfter.toString()).toBe('1000.00');
    expect(first.balanceBefore.toString()).toBe('0.00'); // born zero, realized by OPENING

    const openingTx = await transactions.findById(first.transactionId);
    expect(openingTx!.kind).toBe(WagerTransactionKind.Opening);
    expect(openingTx!.status).toBe(WagerTransactionStatus.Processed);

    const events = await (orm.em as Db).execute<Array<{ event_type: string }>>('SELECT event_type FROM outbox_messages ORDER BY event_type', [], 'all');
    expect(events.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('creates zero-balance wallet without OPENING transaction or ledger entries', async () => {
    const { wallet } = await createWallet.execute({
      playerId: 'player-2',
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.isZero()).toBe(true);
    const page = await ledger.listByWalletId(wallet.id, { limit: 10 });
    expect(page.items).toHaveLength(0);
    const events = await (orm.em as Db).execute<Array<{ count: string }>>('SELECT count(*) AS count FROM outbox_messages', [], 'all');
    expect(events[0]!.count).toBe('0');
  });

  it('fails as conflict on duplicated (playerId, currency)', async () => {
    await createWallet.execute({
      playerId: 'player-3',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(
      createWallet.execute({
        playerId: 'player-3',
        initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
      }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });

  it('same player, different currency: allowed (multi-currency model)', async () => {
    await createWallet.execute({ playerId: 'player-4', initialBalance: Money.zero('BRL') });
    const { wallet } = await createWallet.execute({
      playerId: 'player-4',
      initialBalance: Money.from({ amount: '5.00', currency: 'USD' }),
    });
    expect(wallet.currency).toBe('USD');
  });
});

describe('ReconcileWalletUseCase', () => {
  it('reports consistent when balance matches ledger', async () => {
    const { wallet } = await createWallet.execute({
      playerId: 'player-5',
      initialBalance: Money.from({ amount: '250.00', currency: 'BRL' }),
    });

    const result = await reconcile.execute(wallet.id);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance).toEqual({ amount: '250.00', currency: 'BRL' });
    expect(result.calculatedBalance).toEqual({ amount: '250.00', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.checkedEntries).toBe(1);
  });

  it('detects divergence without correcting it', async () => {
    const { wallet } = await createWallet.execute({
      playerId: 'player-6',
      initialBalance: Money.from({ amount: '250.00', currency: 'BRL' }),
    });

    // simulate drift: someone tampered with the stored balance
    await (orm.em as Db).execute('UPDATE wallets SET balance = 240.00 WHERE id = ?', [wallet.id]);

    let divergenceNotified: unknown = null;
    const vigilant = new ReconcileWalletUseCase({
      wallets: new MikroOrmWalletRepository(orm),
      ledger,
      onDivergence: (result) => (divergenceNotified = result),
    });

    const result = await vigilant.execute(wallet.id);
    expect(result.consistent).toBe(false);
    expect(result.storedBalance).toEqual({ amount: '240.00', currency: 'BRL' });
    expect(result.calculatedBalance).toEqual({ amount: '250.00', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(divergenceNotified).not.toBeNull();

    // balance was NOT silently corrected
    const stored = await (orm.em as Db).execute<Array<{ balance: string }>>('SELECT balance FROM wallets WHERE id = ?', [wallet.id], 'all');
    expect((stored[0] as { balance: string }).balance).toBe('240.00');
  });

  it('throws for unknown wallet', async () => {
    expect(reconcile.execute(crypto.randomUUID())).rejects.toThrow(WalletNotFoundError);
  });
});
