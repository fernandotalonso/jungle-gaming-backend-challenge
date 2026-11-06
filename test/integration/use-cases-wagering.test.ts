import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import type { Db } from '../../src/shared/application/db';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { WagerTransactionApplier } from '../../src/modules/wagering/application/wager-transaction-applier';
import { SubmitWagerTransactionUseCase, type SubmitWagerTransactionCommand } from '../../src/modules/wagering/application/submit-wager-transaction.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/modules/wagering/application/reprocess-pending-references.use-case';
import { IdempotencyConflictError } from '../../src/modules/wagering/application/idempotency-conflict.error';
import { WagerTransactionKind, WagerTransactionStatus, MAX_REFERENCE_ATTEMPTS } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/shared/domain/ledger-direction';
import { getTestOrm, truncateAll } from '../helpers/db';

let orm: MikroORM;
let wallets: MikroOrmWalletRepository;
let ledger: MikroOrmLedgerRepository;
let transactions: MikroOrmWagerTransactionRepository;
let outbox: MikroOrmOutboxRepository;
let uow: MikroOrmUnitOfWork;
let submit: SubmitWagerTransactionUseCase;
let reprocess: ReprocessPendingReferencesUseCase;
let createWallet: CreateWalletUseCase;

beforeAll(async () => {
  orm = await getTestOrm();
  wallets = new MikroOrmWalletRepository(orm);
  ledger = new MikroOrmLedgerRepository(orm);
  transactions = new MikroOrmWagerTransactionRepository(orm);
  outbox = new MikroOrmOutboxRepository();
  uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWalletUseCase({ uow, wallets, transactions, ledger, outbox });
  const applier = new WagerTransactionApplier(wallets, ledger, transactions, outbox);
  submit = new SubmitWagerTransactionUseCase({ uow, wallets, transactions, ledger, outbox, applier });
  reprocess = new ReprocessPendingReferencesUseCase({ uow, wallets, transactions, outbox, applier });
});

beforeEach(async () => {
  await truncateAll(orm);
});

async function seedWallet(balance = '100.00', playerId = 'player-1'): Promise<string> {
  const { wallet } = await createWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
  return wallet.id;
}

function betCommand(walletId: string, amount = '10.00', overrides: Partial<SubmitWagerTransactionCommand> = {}): SubmitWagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    playerId: 'player-1',
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: 'BRL' }),
    ...overrides,
  };
}

describe('SubmitWagerTransactionUseCase — happy paths', () => {
  it('processes a BET: debit, ledger entry and events', async () => {
    const walletId = await seedWallet('100.00');
    const result = await submit.execute(betCommand(walletId, '25.00'));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);

    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('75.00');
    expect(wallet!.version).toBe(2);

    const page = await ledger.listByWalletId(walletId, { limit: 10 });
    const debit = page.items.find((entry) => entry.direction === LedgerDirection.Debit);
    expect(debit).toBeDefined();
    expect(debit!.money.toString()).toBe('25.00');

    const events = await (orm.em as Db).execute<Array<{ event_type: string }>>('SELECT event_type FROM outbox_messages ORDER BY event_type', [], 'all');
    const types = events.map((row) => row.event_type);
    expect(types).toContain('WagerTransactionProcessed');
    expect(types).toContain('WalletBalanceChanged');
  });

  it('processes a LOSS: no balance change, no entry, but Processed event', async () => {
    const walletId = await seedWallet('100.00');
    const result = await submit.execute(betCommand(walletId, '10.00', { kind: WagerTransactionKind.Loss }));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('100.00');
    expect(wallet!.version).toBe(1); // unchanged

    const page = await ledger.listByWalletId(walletId, { limit: 10 });
    expect(page.items).toHaveLength(1); // only the OPENING entry

    // the LOSS itself emitted Processed (no WalletBalanceChanged for its tx)
    const events = await (orm.em as Db).execute<Array<{ event_type: string; payload: { data: { transactionId: string } } }>>(
      'SELECT event_type, payload FROM outbox_messages',
      [],
      'all',
    );
    const processedForLoss = events.filter(
      (row) => row.event_type === 'WagerTransactionProcessed' && row.payload.data.transactionId === result.transactionId,
    );
    expect(processedForLoss).toHaveLength(1);
    const balanceChangedForLoss = events.filter(
      (row) => row.event_type === 'WalletBalanceChanged' && row.payload.data.transactionId === result.transactionId,
    );
    expect(balanceChangedForLoss).toHaveLength(0);
  });
});

describe('SubmitWagerTransactionUseCase — idempotency', () => {
  it('replays the original result (with the originally observed balance)', async () => {
    const walletId = await seedWallet('100.00');
    const command = betCommand(walletId, '10.00');

    const first = await submit.execute(command);
    expect(first.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    // wallet keeps moving after the original BET
    await submit.execute(betCommand(walletId, '30.00'));
    const walletAfter = await wallets.findById(walletId);
    expect(walletAfter!.balance.toString()).toBe('60.00');

    const replay = await submit.execute({ ...command, externalTransactionId: command.externalTransactionId });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    // ORIGINAL observed balance, not the current one (README 7.7)
    expect(replay.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    // exactly two debits total (originals only — replay had no effect)
    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('60.00');
    expect(wallet!.version).toBe(3); // opening(1) + bet(2) + second bet(3)
  });

  it('same key with a different payload is a CONFLICT, not a replay', async () => {
    const walletId = await seedWallet('100.00');
    const command = betCommand(walletId, '10.00');
    await submit.execute(command);

    const conflicting = { ...command, money: Money.from({ amount: '20.00', currency: 'BRL' }) };
    expect(submit.execute(conflicting)).rejects.toThrow(IdempotencyConflictError);

    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('90.00'); // conflict had no effect
  });

  it('resolves concurrent same-key submissions as one effect + replay', async () => {
    const walletId = await seedWallet('100.00');
    const command = betCommand(walletId, '40.00');

    const [a, b] = await Promise.all([
      submit.execute(command),
      submit.execute({ ...command }),
    ]);

    const processed = [a, b].filter((result) => !result.idempotentReplay);
    const replays = [a, b].filter((result) => result.idempotentReplay);
    expect(processed).toHaveLength(1);
    expect(replays).toHaveLength(1);

    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('60.00'); // single debit
  });
});

describe('SubmitWagerTransactionUseCase — business rules (README 7)', () => {
  it('rejects BET with insufficient funds and stays auditable', async () => {
    const walletId = await seedWallet('100.00');
    const result = await submit.execute(betCommand(walletId, '100.01'));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const events = await (orm.em as Db).execute<Array<{ event_type: string }>>('SELECT event_type FROM outbox_messages ORDER BY event_type', [], 'all');
    expect(events.map((row) => row.event_type)).toContain('WagerTransactionRejected');
  });

  it('rejects transactions in a currency different from the wallet', async () => {
    const walletId = await seedWallet('100.00');
    const result = await submit.execute({
      ...betCommand(walletId, '10.00'),
      money: Money.from({ amount: '10.00', currency: 'USD' }),
    });
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
  });

  it('rejects when the wallet does not exist', async () => {
    const result = await submit.execute(betCommand(crypto.randomUUID(), '10.00'));
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WALLET_NOT_FOUND);
    expect(result.balance).toBeNull();
  });

  it('REFUND reverts a BET exactly once; second REFUND is REFERENCE_ALREADY_REVERSED', async () => {
    const walletId = await seedWallet('100.00');
    const bet = await submit.execute(betCommand(walletId, '30.00'));
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const refund = await submit.execute({
      ...betCommand(walletId, '30.00', { kind: WagerTransactionKind.Refund }),
      referenceExternalTransactionId: (
        await transactions.findById(bet.transactionId)
      )!.externalTransactionId,
    });
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const secondRefund = await submit.execute({
      ...betCommand(walletId, '30.00', { kind: WagerTransactionKind.Refund }),
      referenceExternalTransactionId: (
        await transactions.findById(bet.transactionId)
      )!.externalTransactionId,
    });
    expect(secondRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(secondRefund.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
    expect(secondRefund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('ROLLBACK inverts the reference direction (WIN -> debit)', async () => {
    const walletId = await seedWallet('100.00');
    const bet = betCommand(walletId, '10.00');
    const processedBet = await submit.execute(bet);
    const win = await submit.execute({
      ...betCommand(walletId, '50.00', { kind: WagerTransactionKind.Win }),
      referenceExternalTransactionId: (await transactions.findById(processedBet.transactionId))!.externalTransactionId,
    });
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance).toEqual({ amount: '140.00', currency: 'BRL' });

    const rollback = await submit.execute({
      ...betCommand(walletId, '50.00', { kind: WagerTransactionKind.Rollback }),
      referenceExternalTransactionId: (await transactions.findById(win.transactionId))!.externalTransactionId,
    });
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance).toEqual({ amount: '90.00', currency: 'BRL' }); // 140 - 50 (inverse of the WIN credit)
  });

  it('reversal that would go negative gets its own failure code (rule 7.9)', async () => {
    const walletId = await seedWallet('100.00');
    const bet = betCommand(walletId, '10.00');
    const processedBet = await submit.execute(bet);
    await submit.execute({
      ...betCommand(walletId, '50.00', { kind: WagerTransactionKind.Win }),
      referenceExternalTransactionId: (await transactions.findById(processedBet.transactionId))!.externalTransactionId,
    });
    // balance: 100 - 10 + 50 = 140; spend almost everything
    await submit.execute(betCommand(walletId, '139.00'));
    // balance 1.00; ROLLBACK the WIN (debit 50.00) would go negative
    const win = await uow.run(async (db) => {
      const rows = await db.execute<Array<{ id: string }>>(
        "SELECT id FROM wager_transactions WHERE kind = 'WIN' AND status = 'PROCESSED' LIMIT 1",
        [],
        'all',
      );
      return rows[0]!;
    });

    const rollback = await submit.execute({
      ...betCommand(walletId, '50.00', { kind: WagerTransactionKind.Rollback }),
      referenceExternalTransactionId: (await transactions.findById(win.id))!.externalTransactionId,
    });

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS_FOR_REVERSAL);
    expect(rollback.failureCode).not.toBe(FailureCode.INSUFFICIENT_FUNDS);
  });

  it('rejects reversal with a different amount (rule 7.5)', async () => {
    const walletId = await seedWallet('100.00');
    const bet = await submit.execute(betCommand(walletId, '30.00'));
    const betTx = await transactions.findById(bet.transactionId);

    const refund = await submit.execute({
      ...betCommand(walletId, '10.00', { kind: WagerTransactionKind.Refund }),
      referenceExternalTransactionId: betTx!.externalTransactionId,
    });
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.AMOUNT_MISMATCH);
  });

  it('rejects reversal with mismatched context (round) (rule 7.2)', async () => {
    const walletId = await seedWallet('100.00');
    const bet = await submit.execute(betCommand(walletId, '30.00'));
    const betTx = await transactions.findById(bet.transactionId);

    const refund = await submit.execute({
      ...betCommand(walletId, '30.00', { kind: WagerTransactionKind.Refund, roundId: 'round-OTHER' }),
      referenceExternalTransactionId: betTx!.externalTransactionId,
    });
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.REFERENCE_CONTEXT_MISMATCH);
  });

  it('rejects REFUND referencing a WIN and ROLLBACK referencing a LOSS (rule 7.3)', async () => {
    const walletId = await seedWallet('100.00');
    const bet = betCommand(walletId, '10.00');
    const processedBet = await submit.execute(bet);
    const betTx = await transactions.findById(processedBet.transactionId);

    const win = await submit.execute({
      ...betCommand(walletId, '20.00', { kind: WagerTransactionKind.Win }),
      referenceExternalTransactionId: betTx!.externalTransactionId,
    });
    const winTx = await transactions.findById(win.transactionId);

    const loss = await submit.execute(betCommand(walletId, '5.00', { kind: WagerTransactionKind.Loss }));
    const lossTx = await transactions.findById(loss.transactionId);

    const refundOnWin = await submit.execute({
      ...betCommand(walletId, '20.00', { kind: WagerTransactionKind.Refund }),
      referenceExternalTransactionId: winTx!.externalTransactionId,
    });
    expect(refundOnWin.failureCode).toBe(FailureCode.REFERENCE_KIND_MISMATCH);

    const rollbackOnLoss = await submit.execute({
      ...betCommand(walletId, '5.00', { kind: WagerTransactionKind.Rollback }),
      referenceExternalTransactionId: lossTx!.externalTransactionId,
    });
    expect(rollbackOnLoss.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollbackOnLoss.failureCode).toBe(FailureCode.REFERENCE_KIND_MISMATCH);
  });
});

describe('PENDING_REFERENCE + reprocessing worker (README 7.1)', () => {
  it('holds a refund whose reference has not arrived, then the worker applies it', async () => {
    const walletId = await seedWallet('100.00');

    // REFUND arrives BEFORE its BET (out of order)
    const referenceExtId = `ext-${crypto.randomUUID()}`;
    const refund = await submit.execute({
      ...betCommand(walletId, '30.00', { kind: WagerTransactionKind.Refund }),
      referenceExternalTransactionId: referenceExtId,
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const pendingTx = await transactions.findById(refund.transactionId);
    expect(pendingTx!.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pendingTx!.referenceAttempts).toBe(1);

    // events include the pending-reference notification
    const eventsBefore = await (orm.em as Db).execute<Array<{ event_type: string }>>('SELECT event_type FROM outbox_messages', [], 'all');
    expect(eventsBefore.map((row: { event_type: string }) => row.event_type)).toContain(
      'WagerTransactionPendingReference',
    );

    // the BET finally arrives (processed)
    const bet = await submit.execute({
      ...betCommand(walletId, '30.00'),
      externalTransactionId: referenceExtId,
      idempotencyKey: `provider-a:${referenceExtId}`,
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    // worker runs after the backoff elapsed
    const pendingRow = await transactions.findById(refund.transactionId);
    const dueAt = pendingRow!.nextReferenceCheckAt!;
    const summary = await reprocess.execute(new Date(dueAt.getTime() + 1));
    expect(summary.processed).toBe(1);

    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('100.00'); // 100 - 30 (bet) + 30 (refund): net zero

    const appliedRefund = await transactions.findById(refund.transactionId);
    expect(appliedRefund!.status).toBe(WagerTransactionStatus.Processed);
    expect(appliedRefund!.referenceTransactionId).toBe(bet.transactionId);
  });

  it('rejects with REFERENCE_NOT_FOUND when attempts are exhausted', async () => {
    const walletId = await seedWallet('100.00');
    const refund = await submit.execute({
      ...betCommand(walletId, '30.00', { kind: WagerTransactionKind.Refund }),
      referenceExternalTransactionId: `ext-${crypto.randomUUID()}`,
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    // simulate the passage of time: schedule until attempts reach the limit
    let now = new Date();
    for (let i = 0; i < MAX_REFERENCE_ATTEMPTS - 1; i++) {
      const tx = await transactions.findById(refund.transactionId);
      tx!.scheduleReferenceCheck(now);
      const current = tx!;
      await uow.run(async (db) => transactions.update(current, db));
      now = current.nextReferenceCheckAt!;
    }

    const summary = await reprocess.execute(now);
    expect(summary.rejected).toBe(1);

    const rejected = await transactions.findById(refund.transactionId);
    expect(rejected!.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected!.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);

    const events = await (orm.em as Db).execute<Array<{ event_type: string }>>('SELECT event_type FROM outbox_messages', [], 'all');
    expect(events.map((row) => row.event_type)).toContain('WagerTransactionRejected');
  });
});

describe('concurrency scenario (README 8) — same wallet, parallel submissions', () => {
  it('two competing BETs of 80.00 on a 100.00 wallet: exactly one PROCESSED', async () => {
    const walletId = await seedWallet('100.00');

    const results = await Promise.all([
      submit.execute(betCommand(walletId, '80.00')),
      submit.execute(betCommand(walletId, '80.00')),
    ]);

    const processed = results.filter((result) => result.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((result) => result.status === WagerTransactionStatus.Rejected);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    const wallet = await wallets.findById(walletId);
    expect(wallet!.balance.toString()).toBe('20.00'); // never negative

    const page = await ledger.listByWalletId(walletId, { limit: 10 });
    const debits = page.items.filter((entry) => entry.direction === LedgerDirection.Debit);
    expect(debits).toHaveLength(1); // exactly one debit entry
    expect(debits[0]!.balanceAfter.toString()).toBe('20.00');
  });

  it('different wallets are processed in parallel without interference', async () => {
    const w1 = await seedWallet('100.00', 'player-parallel-1');
    const w2 = await seedWallet('100.00', 'player-parallel-2');

    const [r1, r2] = await Promise.all([
      submit.execute(betCommand(w1, '60.00')),
      submit.execute(betCommand(w2, '70.00')),
    ]);

    expect(r1.status).toBe(WagerTransactionStatus.Processed);
    expect(r2.status).toBe(WagerTransactionStatus.Processed);
    expect((await wallets.findById(w1))!.balance.toString()).toBe('40.00');
    expect((await wallets.findById(w2))!.balance.toString()).toBe('30.00');
  });
});
