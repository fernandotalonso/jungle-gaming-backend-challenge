import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { generateId } from '../../../shared/ids';
import { payloadHash } from '../../../shared/canonical-json';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import type { Db } from '../../../shared/application/db';
import type { UnitOfWork } from '../../../shared/application/ports/unit-of-work';
import type { LedgerRepository } from '../../wallets/application/ports/ledger.repository';
import type { WalletRepository } from '../../wallets/application/ports/wallet.repository';
import type { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import type { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { FailureCode } from '../domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { IdempotencyConflictError } from './idempotency-conflict.error';
import {
  WagerTransactionApplier,
  type ProcessContext,
} from './wager-transaction-applier';

export interface SubmitWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  /** the source of truth for idempotency (README 9) */
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** balance observed for the original result; null when no wallet exists */
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

interface Deps {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  applier: WagerTransactionApplier;
}

/**
 * Single entrypoint for wager transactions — reused verbatim by the HTTP API
 * and the SQS consumer (README 10). Guarantees:
 *
 * - idempotency: the persisted unique key is the source of truth; replays
 *   return the ORIGINAL result (including the balance observed at that
 *   moment, reconstructed from the ledger); a different payload under the
 *   same key is a conflict (README 9);
 * - atomicity: wallet movement, ledger entry, transaction record and outbox
 *   events commit in one SQL transaction;
 * - out-of-order references: missing references persist as PENDING_REFERENCE
 *   and are reprocessed by the worker with backoff (README 7.1/7.8);
 * - concurrency: the wallet row is locked for update — the wallet is the unit
 *   of concurrency (README 8).
 */
export class SubmitWagerTransactionUseCase {
  constructor(private readonly deps: Deps) {}

  async execute(
    command: SubmitWagerTransactionCommand,
    ctx?: { correlationId?: string },
  ): Promise<SubmitWagerTransactionResult> {
    const correlationId = ctx?.correlationId ?? generateId();
    const payloadHashValue = computePayloadHash(command);

    // optimization: skip the transaction when the key is already known — the
    // DB unique constraint remains the actual guarantee for concurrent races
    const existing = await this.deps.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      return this.resolveExisting(existing, payloadHashValue);
    }

    try {
      return await this.deps.uow.run(async (db: Db): Promise<SubmitWagerTransactionResult> => {
        const now = new Date();
        const tx = WagerTransaction.create({
          id: generateId(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash: payloadHashValue,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money: command.money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: now,
        });

        const wallet = await this.deps.wallets.findByIdForUpdate(command.walletId, db);
        const outcome = await this.deps.applier.process(db, tx, wallet, now, { correlationId });

        return {
          transactionId: tx.id,
          status: outcome.status,
          balance: outcome.balance,
          failureCode: outcome.failureCode,
          idempotentReplay: false,
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // concurrent submission with the same key committed first: resolve as
        // replay or conflict — never duplicate the effect
        const winner = await this.deps.transactions.findByIdempotencyKey(command.idempotencyKey);
        if (!winner) {
          throw error;
        }
        return this.resolveExisting(winner, payloadHashValue);
      }
      throw error;
    }
  }

  private async resolveExisting(tx: WagerTransaction, payloadHashValue: string): Promise<SubmitWagerTransactionResult> {
    if (!tx.matchesPayload(payloadHashValue)) {
      throw new IdempotencyConflictError(tx.idempotencyKey);
    }
    const balance = await this.observedBalance(tx);
    return {
      transactionId: tx.id,
      status: tx.status,
      balance,
      failureCode: tx.failureCode,
      idempotentReplay: true,
    };
  }

  /**
   * Reconstructs the balance observed when the transaction reached its
   * current state — from the ledger, never from ad-hoc snapshots:
   * entries expose balanceAfter; non-movement transactions resolve to the
   * balanceBefore of the next entry (or current balance when none).
   */
  private async observedBalance(tx: WagerTransaction): Promise<MoneyProps | null> {
    if (tx.status === WagerTransactionStatus.PendingReference) {
      const wallet = await this.deps.wallets.findById(tx.walletId);
      return wallet ? wallet.balance.toJSON() : null;
    }
      return this.deps.uow.run(async (db: Db) => {
        const wallet = await this.deps.wallets.findById(tx.walletId, db);
        if (!wallet) {
          return null;
        }
        return await this.deps.applier.observedBalance(db, wallet, tx);
      });
  }
}

export function computePayloadHash(command: SubmitWagerTransactionCommand): string {
  // canonical JSON over the business subset; transport headers and metadata
  // are intentionally excluded (README 9)
  return payloadHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}

export type { ProcessContext };
