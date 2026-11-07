import { generateId } from '../../../shared/ids';
import type { Db } from '../../../shared/application/db';
import type { UnitOfWork } from '../../../shared/application/ports/unit-of-work';
import type { WalletRepository } from '../../wallets/application/ports/wallet.repository';
import type { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import type { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus, MAX_REFERENCE_ATTEMPTS } from '../domain/wager-transaction';
import type { ProcessContext, ProcessOutcome } from './wager-transaction-applier';
import { WagerTransactionApplier } from './wager-transaction-applier';
import { metrics } from '../../../observability/metrics';

export interface ReprocessSummary {
  checked: number;
  processed: number;
  rejected: number;
  stillPending: number;
}

interface Deps {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  applier: WagerTransactionApplier;
}

/**
 * Reprocesses PENDING_REFERENCE transactions whose backoff has elapsed
 * (README 7.1). Claims rows with FOR UPDATE SKIP LOCKED, so multiple
 * instances can run concurrently without stepping on each other. When the
 * reference never arrives and attempts are exhausted, the transaction is
 * REJECTED with REFERENCE_NOT_FOUND and the corresponding event is published.
 */
export class ReprocessPendingReferencesUseCase {
  constructor(private readonly deps: Deps) {}

  async execute(
    now = new Date(),
    limit = 50,
    ctx?: { correlationId?: string },
  ): Promise<ReprocessSummary> {
    const correlationId = ctx?.correlationId ?? generateId();

    return this.deps.uow.run(async (db: Db): Promise<ReprocessSummary> => {
      const pending = await this.deps.transactions.findPendingReferences(db, now, limit);
      let processed = 0;
      let rejected = 0;
      let stillPending = 0;

      for (const tx of pending) {
        const processCtx: ProcessContext = { correlationId };

        // TTL/exhaustion: attempts grow on every scheduled check
        if (tx.referenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
          await this.deps.applier.rejectOnly(
            db,
            tx,
            FailureCode.REFERENCE_NOT_FOUND,
            `reference "${tx.referenceExternalTransactionId}" not found after ${MAX_REFERENCE_ATTEMPTS} attempts`,
            now,
            processCtx,
            { alreadyPersisted: true },
          );
          rejected += 1;
          continue;
        }

        const wallet = await this.deps.wallets.findByIdForUpdate(tx.walletId, db);
        if (!wallet) {
          await this.deps.applier.rejectOnly(
            db,
            tx,
            FailureCode.WALLET_NOT_FOUND,
            'wallet does not exist',
            now,
            processCtx,
            { alreadyPersisted: true },
          );
          rejected += 1;
          continue;
        }

        const outcome: ProcessOutcome = await this.deps.applier.process(db, tx, wallet, now, processCtx, {
          alreadyPersisted: true,
        });
        metrics.transaction(outcome.status);
        if (outcome.status === WagerTransactionStatus.Processed) {
          processed += 1;
        } else if (outcome.status === WagerTransactionStatus.Rejected) {
          rejected += 1;
        } else {
          stillPending += 1; // rescheduled with a longer backoff
        }
      }

      return { checked: pending.length, processed, rejected, stillPending };
    });
  }
}
