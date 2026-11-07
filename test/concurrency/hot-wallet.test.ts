import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { getTestOrm, truncateAll } from '../helpers/db';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { WagerTransactionApplier } from '../../src/modules/wagering/application/wager-transaction-applier';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { SubmitWagerTransactionUseCase, type SubmitWagerTransactionCommand, type SubmitWagerTransactionResult } from '../../src/modules/wagering/application/submit-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { expectLedgerConsistency } from './invariants';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/shared/domain/ledger-direction';

let orm: MikroORM;
let wallets: MikroOrmWalletRepository;
let ledger: MikroOrmLedgerRepository;
let transactions: MikroOrmWagerTransactionRepository;
let uow: MikroOrmUnitOfWork;
let outbox: MikroOrmOutboxRepository;
let submit: SubmitWagerTransactionUseCase;
let createWallet: CreateWalletUseCase;

const PROVIDER = 'provider-a';
const PLAYER = 'player-hot';

beforeAll(async () => {
  orm = await getTestOrm();
  wallets = new MikroOrmWalletRepository(orm);
  ledger = new MikroOrmLedgerRepository(orm);
  transactions = new MikroOrmWagerTransactionRepository(orm);
  uow = new MikroOrmUnitOfWork(orm);
  outbox = new MikroOrmOutboxRepository();
  const applier = new WagerTransactionApplier(wallets, ledger, transactions, outbox);
  const outboxRepo = outbox;
  submit = new SubmitWagerTransactionUseCase({ uow, wallets, transactions, ledger, outbox: outboxRepo, applier });
  createWallet = new CreateWalletUseCase({ uow, wallets, transactions, ledger, outbox: outboxRepo });
});

beforeEach(async () => {
  await truncateAll(orm);
});

async function seedWallet(balance: string): Promise<Wallet> {
  // seeded through the real use case: the OPENING transaction realizes the
  // initial balance in the ledger, so the wallet is consistent from birth
  const { wallet } = await createWallet.execute({
    playerId: PLAYER,
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
  return wallet;
}

function bet(walletId: string, amount: string, idempotencyKey?: string): SubmitWagerTransactionCommand {
  return {
    providerId: PROVIDER,
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: idempotencyKey ?? `key-${crypto.randomUUID()}`,
    playerId: PLAYER,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: 'BRL' }),
  };
}

describe('hot wallet — 50 identical bets in parallel (README 13.1)', () => {
  it(
    'exactly one debit; the other 49 are idempotent replays',
    async () => {
      const wallet = await seedWallet('100.00');
      const command = bet(wallet.id, '25.00', 'hot-wallet-same-key');

      const results = await Promise.all(Array.from({ length: 50 }, () => submit.execute(command)));

      const processed = results.filter((result) => result.status === 'PROCESSED' && !result.idempotentReplay);
      const replays = results.filter((result) => result.idempotentReplay);
      expect(processed).toHaveLength(1);
      expect(replays).toHaveLength(49);

      // every replay points at the same original transaction
      const uniqueTransactionIds = new Set(results.map((result) => result.transactionId));
      expect(uniqueTransactionIds.size).toBe(1);

      const walletAfter = await wallets.findById(wallet.id);
      expect(walletAfter!.balance.toString()).toBe('75.00');
      expect(walletAfter!.version).toBe(2); // opening(1) + one debit

      const page = await ledger.listByWalletId(wallet.id, { limit: 10 });
      const debits = page.items.filter((entry) => entry.direction === LedgerDirection.Debit);
      expect(debits).toHaveLength(1); // exactly one debit entry

      await expectLedgerConsistency(orm, wallet.id);
    },
    120_000,
  );
});

describe('hot wallet — 50 competing bets on limited funds (README 8)', () => {
  it(
    '20 processed, 30 rejected, balance exactly zero, 20 debit entries',
    async () => {
      const wallet = await seedWallet('1000.00');
      const commands = Array.from({ length: 50 }, (_, index) => bet(wallet.id, '50.00', `competing-key-${index}`));

      const results = await Promise.all(commands.map((command) => submit.execute(command)));

      const processed = results.filter((result) => result.status === 'PROCESSED');
      const rejected = results.filter((result) => result.status === 'REJECTED');
      expect(processed).toHaveLength(20);
      expect(rejected).toHaveLength(30);
      for (const result of rejected) {
        expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
      }

      const walletAfter = await wallets.findById(wallet.id);
      expect(walletAfter!.balance.toString()).toBe('0.00'); // never negative
      expect(walletAfter!.balance.isNegative()).toBe(false);

      const page = await ledger.listByWalletId(wallet.id, { limit: 200 });
      const debits = page.items.filter((entry) => entry.direction === LedgerDirection.Debit);
      expect(debits).toHaveLength(20);
      const debitSum = debits.reduce((total, entry) => total.add(entry.money), Money.zero('BRL'));
      expect(debitSum.toString()).toBe('1000.00');

      await expectLedgerConsistency(orm, wallet.id);
    },
    120_000,
  );
});

describe('mixed operations racing on one wallet (README 7 rules under parallelism)', () => {
  it(
    'parallel WINs/LOSSs/REFUNDs on processed BETs keep the ledger consistent',
    async () => {
      const wallet = await seedWallet('500.00');

      // 10 BETs of 20.00 first: balance 500 -> 300
      const bets = Array.from({ length: 10 }, () => bet(wallet.id, '20.00'));
      const betResults = await Promise.all(bets.map((command) => submit.execute(command)));
      expect(betResults.every((result) => result.status === 'PROCESSED')).toBe(true);

      const betExternalIds = await Promise.all(
        betResults.map(async (result) => (await transactions.findById(result.transactionId))!.externalTransactionId),
      );

      // race: 10 LOSS + 5 WIN + 3 REFUND, all in parallel
      const lossCommands = Array.from({ length: 10 }, () => bet(wallet.id, '20.00', `loss-${crypto.randomUUID()}`));
      const lossCommandsTyped = lossCommands.map((command) => ({ ...command, kind: WagerTransactionKind.Loss }));

      const winCommands: SubmitWagerTransactionCommand[] = betExternalIds.slice(0, 5).map((reference) => ({
        ...bet(wallet.id, '20.00', `win-${reference}`),
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: reference,
      }));
      const refundCommands = betExternalIds.slice(5, 8).map((reference) => ({
        ...bet(wallet.id, '20.00', `refund-${reference}`),
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: reference,
      }));

      const [lossResults, winResults, refundResults] = await Promise.all([
        Promise.all(lossCommandsTyped.map((command) => submit.execute(command))),
        Promise.all(winCommands.map(async (command) => submit.execute(command))),
        Promise.all(refundCommands.map(async (command) => submit.execute(command))),
      ]);

      // 10 LOSS: no balance effect, all processed
      expect(lossResults.every((result: SubmitWagerTransactionResult) => result.status === 'PROCESSED')).toBe(true);
      // 5 WIN: +20.00 each -> +100.00
      expect(winResults.every((result: SubmitWagerTransactionResult) => result.status === 'PROCESSED')).toBe(true);
      // 3 REFUND: +20.00 each -> +60.00
      expect(refundResults.every((result: SubmitWagerTransactionResult) => result.status === 'PROCESSED')).toBe(true);

      // 500 - 200 (bets) + 100 (wins) + 60 (refunds) = 460.00
      const walletAfter = await wallets.findById(wallet.id);
      expect(walletAfter!.balance.toString()).toBe('460.00');

      // replaying one WIN must not change anything: the EXACT original command
      const winReplay = await submit.execute(winCommands[0]!);
      expect(winReplay.idempotentReplay).toBe(true);
      expect((await wallets.findById(wallet.id))!.balance.toString()).toBe('460.00');

      await expectLedgerConsistency(orm, wallet.id);
    },
    120_000,
  );
});
