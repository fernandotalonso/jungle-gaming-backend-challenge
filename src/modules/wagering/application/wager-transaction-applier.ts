import type { Db } from '../../../shared/application/db';
import type { LedgerRepository } from '../../wallets/application/ports/ledger.repository';
import type { WalletRepository } from '../../wallets/application/ports/wallet.repository';
import type { Wallet } from '../../wallets/domain/wallet';
import { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../messaging/domain/events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../../messaging/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../messaging/domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../../messaging/domain/events/wager-transaction-pending-reference';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import { LedgerDirection } from '../../../shared/domain/ledger-direction';
import type { MoneyProps } from '../../../shared/domain/money';
import { InsufficientFundsError } from '../../../shared/domain/errors';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { FailureCode } from '../domain/failure-code';
import type { WagerTransactionRepository } from './ports/wager-transaction.repository';

export interface ProcessContext {
  correlationId: string;
}

export interface ProcessOutcome {
  status: WagerTransactionStatus;
  /** balance observed for the result; null when there is no wallet to observe */
  balance: MoneyProps | null;
  failureCode?: FailureCode;
}

const REVERSIBLE_KINDS_FOR_ROLLBACK: WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

/**
 * Shared processing core for every entrypoint (HTTP, SQS, pending-reference
 * worker). Drives a non-terminal transaction to a terminal state — PROCESSED
 * (wallet + ledger + outbox in the same SQL transaction) or REJECTED
 * (auditable, with failure code and event) — or holds it as
 * PENDING_REFERENCE with backoff scheduled.
 *
 * All rules from README section 7 are enforced here:
 * reversals reference a PROCESSED BET/WIN/REFUND of the same provider, player,
 * wallet, currency and round; the amount must match; a reference is reverted
 * exactly once (see ARCHITECTURE.md for the documented interpretation of
 * rule 7.4); insufficient funds for reversals carry their own failure code
 * (rule 7.9).
 */
export class WagerTransactionApplier {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * `wallet` must be locked for update when present (unit of concurrency).
   * `alreadyPersisted`: the transaction row already exists (worker
   * reprocessing) — state changes go through UPDATE instead of INSERT.
   * Returns the terminal outcome; the caller persists nothing else.
   */
  async process(
    db: Db,
    tx: WagerTransaction,
    wallet: Wallet | null,
    now: Date,
    ctx: ProcessContext,
    options: { alreadyPersisted?: boolean } = {},
  ): Promise<ProcessOutcome> {
    const alreadyPersisted = options.alreadyPersisted ?? false;
    if (tx.isTerminal()) {
      throw new Error(`transaction ${tx.id} is terminal and cannot be processed again`);
    }

    if (!wallet) {
      return this.rejectOnly(db, tx, FailureCode.WALLET_NOT_FOUND, 'wallet does not exist', now, ctx, { alreadyPersisted });
    }

    if (tx.money.currency !== wallet.currency) {
      return this.reject(db, tx, wallet, FailureCode.CURRENCY_MISMATCH, 'transaction currency differs from wallet currency', now, ctx, { alreadyPersisted });
    }

    let reference: WagerTransaction | undefined;
    if (tx.requiresReference()) {
      const resolution = await this.resolveReference(db, tx);
      if (resolution.hold) {
        return this.holdForReference(db, tx, wallet, now, ctx, { alreadyPersisted });
      }
      if (resolution.failureCode) {
        return this.reject(db, tx, wallet, resolution.failureCode, resolution.reason ?? 'invalid reference', now, ctx, { alreadyPersisted });
      }
      reference = resolution.reference;
    }

    const direction = tx.ledgerDirectionFor(reference);
    let entry: WalletLedgerEntry | null = null;
    if (direction !== null) {
      try {
        entry =
          direction === LedgerDirection.Debit
            ? wallet.debit(tx.id, tx.money, now)
            : wallet.credit(tx.id, tx.money, now);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          // rule 7.9: reversals that would go negative are operationally distinct
          const code = tx.requiresReference()
            ? FailureCode.INSUFFICIENT_FUNDS_FOR_REVERSAL
            : FailureCode.INSUFFICIENT_FUNDS;
          return this.reject(db, tx, wallet, code, error.message, now, ctx);
        }
        throw error;
      }
    }

    // ---- terminal: PROCESSED — persist everything atomically (caller's tx) ----
    tx.markProcessed(reference?.id, now);
    await this.persistTransaction(tx, db, alreadyPersisted);
    if (entry) {
      await this.wallets.update(wallet, db);
      await this.ledger.insert(entry, db);
    }

    const eventCtx = { correlationId: ctx.correlationId, causationId: tx.id, occurredAt: now };
    await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventCtx)), db);
    if (entry) {
      await this.outbox.insert(
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entryToProps(entry), eventCtx)),
        db,
      );
    }

    return {
      status: WagerTransactionStatus.Processed,
      balance: entry ? entry.balanceAfter.toJSON() : await this.observedBalance(db, wallet, tx),
    };
  }

  /** Rejects without any wallet interaction (e.g. wallet not found, reference TTL exhausted). */
  async rejectOnly(
    db: Db,
    tx: WagerTransaction,
    code: FailureCode,
    reason: string,
    now: Date,
    ctx: ProcessContext,
    options: { alreadyPersisted?: boolean } = {},
  ): Promise<ProcessOutcome> {
    tx.reject(code);
    await this.persistTransaction(tx, db, options.alreadyPersisted ?? false);
    const eventCtx = { correlationId: ctx.correlationId, causationId: tx.id, occurredAt: now };
    await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, reason, eventCtx)), db);
    return { status: WagerTransactionStatus.Rejected, balance: null, failureCode: code };
  }

  // ------------------------------------------------------------------

  private async resolveReference(
    db: Db,
    tx: WagerTransaction,
  ): Promise<
    | { hold: true }
    | { hold: false; failureCode?: FailureCode; reason?: string; reference?: WagerTransaction }
  > {
    const referenceExternalId = tx.referenceExternalTransactionId ?? '';
    const found = await this.transactions.findByProviderAndExternalId(tx.providerId, referenceExternalId, db);

    // rule 7.8: reference not here yet -> persist as PENDING_REFERENCE and reprocess later
    if (!found) {
      return { hold: true };
    }
    if (
      found.status === WagerTransactionStatus.Pending ||
      found.status === WagerTransactionStatus.PendingReference
    ) {
      // exists but not applied yet — nothing to revert, keep waiting
      return { hold: true };
    }
    if (found.status !== WagerTransactionStatus.Processed) {
      // REJECTED/FAILED references can never be reverted
      return { hold: false, failureCode: FailureCode.REFERENCE_KIND_MISMATCH, reason: 'reference was never applied' };
    }

    // rule 7.3: REFUND -> BET only; ROLLBACK -> BET/WIN/REFUND
    const validKinds = tx.kind === WagerTransactionKind.Refund ? [WagerTransactionKind.Bet] : REVERSIBLE_KINDS_FOR_ROLLBACK;
    if (!validKinds.includes(found.kind)) {
      return {
        hold: false,
        failureCode: FailureCode.REFERENCE_KIND_MISMATCH,
        reason: `${tx.kind} cannot reference a ${found.kind}`,
      };
    }

    // rule 7.2: same provider (by lookup), player, wallet, currency and round
    if (
      found.playerId !== tx.playerId ||
      found.walletId !== tx.walletId ||
      found.roundId !== tx.roundId ||
      found.money.currency !== tx.money.currency
    ) {
      return {
        hold: false,
        failureCode: FailureCode.REFERENCE_CONTEXT_MISMATCH,
        reason: 'reference belongs to a different player/wallet/round/currency',
      };
    }

    // rule 7.5: reversal amount must equal the reference amount
    if (!found.money.equals(tx.money)) {
      return {
        hold: false,
        failureCode: FailureCode.AMOUNT_MISMATCH,
        reason: `reversal amount ${tx.money.toString()} differs from reference amount ${found.money.toString()}`,
      };
    }

    // rule 7.4 — documented interpretation (ARCHITECTURE.md): a PROCESSED
    // transaction is reverted exactly once. REFUND-then-ROLLBACK chains are
    // expressed by rolling back the REFUND itself, never the same BET twice.
    const existingReversal = await this.transactions.findProcessedReversalFor(found.id, db);
    if (existingReversal) {
      return {
        hold: false,
        failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
        reason: `reference already reverted by ${existingReversal.kind} ${existingReversal.id}`,
      };
    }

    return { hold: false, reference: found };
  }

  private async holdForReference(
    db: Db,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    ctx: ProcessContext,
    options: { alreadyPersisted?: boolean } = {},
  ): Promise<ProcessOutcome> {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference();
    }
    // worker reprocessing passes through here as well — attempts keep growing
    tx.scheduleReferenceCheck(now);
    await this.persistTransaction(tx, db, options.alreadyPersisted ?? false);
    const eventCtx = { correlationId: ctx.correlationId, causationId: tx.id, occurredAt: now };
    await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventCtx)), db);
    return { status: WagerTransactionStatus.PendingReference, balance: wallet.balance.toJSON() };
  }

  private async reject(
    db: Db,
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    reason: string,
    now: Date,
    ctx: ProcessContext,
    options: { alreadyPersisted?: boolean } = {},
  ): Promise<ProcessOutcome> {
    tx.reject(code);
    await this.persistTransaction(tx, db, options.alreadyPersisted ?? false);
    const eventCtx = { correlationId: ctx.correlationId, causationId: tx.id, occurredAt: now };
    await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, reason, eventCtx)), db);
    return { status: WagerTransactionStatus.Rejected, balance: await this.observedBalance(db, wallet, tx), failureCode: code };
  }

  private async persistTransaction(tx: WagerTransaction, db: Db, alreadyPersisted: boolean): Promise<void> {
    if (alreadyPersisted) {
      await this.transactions.update(tx, db);
    } else {
      await this.transactions.insert(tx, db);
    }
  }

  /**
   * Balance observed "at the moment" of a transaction that did not move the
   * wallet (LOSS, REJECTED): the balanceBefore of the next ledger entry, or
   * the current balance when no later entry exists. Fully auditable — no
   * denormalized snapshot needed.
   */
  async observedBalance(db: Db, wallet: Wallet, tx: WagerTransaction): Promise<MoneyProps> {
    const entry = await this.ledger.findByTransactionId(tx.id, db);
    if (entry) {
      return entry.balanceAfter.toJSON();
    }
    const moment = tx.processedAt ?? tx.createdAt;
    const next = await this.ledger.findFirstEntryAfter(wallet.id, moment, db);
    return next ? next.balanceBefore.toJSON() : wallet.balance.toJSON();
  }
}

export function entryToProps(entry: WalletLedgerEntry) {
  return {
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
  };
}
