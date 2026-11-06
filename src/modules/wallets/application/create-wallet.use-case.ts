import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { generateId } from '../../../shared/ids';
import { payloadHash } from '../../../shared/canonical-json';
import type { Db } from '../../../shared/application/db';
import type { UnitOfWork } from '../../../shared/application/ports/unit-of-work';
import { Money } from '../../../shared/domain/money';
import type { LedgerRepository } from './ports/ledger.repository';
import type { WalletRepository } from './ports/wallet.repository';
import { Wallet } from '../domain/wallet';
import { WagerTransactionProcessed } from '../../messaging/domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../messaging/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import type { WagerTransactionRepository } from '../../wagering/application/ports/wager-transaction.repository';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { entryToProps } from '../../wagering/application/wager-transaction-applier';
import { WalletAlreadyExistsError } from './wallet-errors';

export const INTERNAL_PROVIDER = 'internal';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export interface CreateWalletResult {
  wallet: Wallet;
}

interface Deps {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * Creates a wallet. When the initial balance is positive, an internal OPENING
 * transaction is generated in the SAME SQL transaction, with its CREDIT
 * ledger entry — balance and ledger are consistent from the first instant
 * (README 9). Duplicated (playerId, currency) fails as a conflict (DB unique).
 */
export class CreateWalletUseCase {
  constructor(private readonly deps: Deps) {}

  async execute(command: CreateWalletCommand, ctx?: { correlationId?: string }): Promise<CreateWalletResult> {
    const correlationId = ctx?.correlationId ?? generateId();

    try {
      return await this.deps.uow.run(async (db: Db) => {
        const now = new Date();
        const walletId = generateId();
        // creation is a single state transition: the wallet is born with the
        // initial balance (version 1) and the OPENING transaction realizes it
        // in the ledger (0 -> initial), same SQL transaction (README 9)
        const wallet = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance: command.initialBalance,
          now,
        });
        await this.deps.wallets.insert(wallet, db);

        if (command.initialBalance.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: generateId(),
            providerId: INTERNAL_PROVIDER,
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `${INTERNAL_PROVIDER}:opening:${walletId}`,
            payloadHash: payloadHash({
              walletId,
              playerId: command.playerId,
              money: command.initialBalance.toJSON(),
            }),
            walletId,
            playerId: command.playerId,
            money: command.initialBalance,
            createdAt: now,
          });
          opening.markProcessed(undefined, now);

          const entry = wallet.openingEntry(opening.id);
          await this.deps.transactions.insert(opening, db);
          await this.deps.ledger.insert(entry, db);

          const eventCtx = { correlationId, causationId: opening.id, occurredAt: now };
          await this.deps.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventCtx)), db);
          await this.deps.outbox.insert(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entryToProps(entry), eventCtx)),
            db,
          );
        }

        return { wallet };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency);
      }
      throw error;
    }
  }
}
