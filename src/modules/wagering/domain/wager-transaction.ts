import { toDate } from '../../../shared/domain/coerce';
import type { DateLike } from '../../../shared/domain/date-like';
import {
  DomainError,
  InvalidAmountError,
  InvalidReferenceError,
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../../shared/domain/errors';
import { LedgerDirection } from '../../../shared/domain/ledger-direction';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import type { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit — never submittable
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // accepted, not yet applied
  PendingReference = 'PENDING_REFERENCE', // waiting for the referenced transaction
  Processed = 'PROCESSED', // applied (terminal)
  Rejected = 'REJECTED', // business rule violation (terminal)
  Failed = 'FAILED', // permanent infrastructure error (terminal, auditable)
}

/** Pending-reference worker policy (README 7.1): exponential backoff, capped, with attempt limit. */
export const REFERENCE_RETRY_BASE_MS = 1_000;
export const REFERENCE_RETRY_MAX_MS = 60_000;
export const MAX_REFERENCE_ATTEMPTS = 10;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind | string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
  createdAt: DateLike;
  status: WagerTransactionStatus | string;
  referenceTransactionId?: string | null;
  failureCode?: FailureCode | string | null;
  processedAt?: DateLike | null;
  referenceAttempts?: number | null;
  nextReferenceCheckAt?: DateLike | null;
}

/**
 * Valid state transitions (terminal states never change again — attempting a
 * transition from them is a programming error):
 *
 *   PENDING          -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** provider-scoped id — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceAttempts: number = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /** Born PENDING. Rejects the internal OPENING kind and validates reference requirements. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    WagerTransaction.assertPositiveAmount(props.money);
    WagerTransaction.assertRequiredFields(props);

    if (requiresReference(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  /** Internal factory for wallet-opening credits — never exposed via API/queue. */
  static createOpening(props: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt?: Date;
  }): WagerTransaction {
    WagerTransaction.assertPositiveAmount(props.money);
    WagerTransaction.assertRequiredFields({
      ...props,
      roundId: '-',
      gameId: '-',
      kind: WagerTransactionKind.Opening,
    });

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      '-',
      '-',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const kind = state.kind as WagerTransactionKind;
    const status = state.status as WagerTransactionStatus;
    const referenceTransactionId = state.referenceTransactionId ?? undefined;
    const processedAt = state.processedAt == null ? undefined : toDate(state.processedAt);
    const nextReferenceCheckAt =
      state.nextReferenceCheckAt == null ? undefined : toDate(state.nextReferenceCheckAt);

    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      kind,
      Money.from(state.money),
      state.referenceExternalTransactionId ?? undefined,
      toDate(state.createdAt),
      status,
      referenceTransactionId,
      (state.failureCode as FailureCode) ?? undefined,
      processedAt,
      state.referenceAttempts ?? 0,
      nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions (all throw InvalidTransactionStateError from terminal states) ----

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `markPendingReference requires PENDING, got ${this._status}`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Schedules the next reference check with exponential backoff (worker policy
   * in README 7.1). Only valid while waiting for the reference. When attempts
   * reach MAX_REFERENCE_ATTEMPTS the use case must reject the transaction.
   */
  scheduleReferenceCheck(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `scheduleReferenceCheck requires PENDING_REFERENCE, got ${this._status}`,
      );
    }
    this._referenceAttempts += 1;
    const delay = Math.min(
      REFERENCE_RETRY_BASE_MS * 2 ** (this._referenceAttempts - 1),
      REFERENCE_RETRY_MAX_MS,
    );
    this._nextReferenceCheckAt = new Date(now.getTime() + delay);
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- domain queries ----

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** False for LOSS (and REJECTED transactions never get applied — use case responsibility). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Ledger direction this transaction produces once applied. `null` means the
   * transaction does not produce a ledger entry (LOSS).
   *
   * ROLLBACK is the inverse of its reference's direction, so the reference
   * must be resolvable and be a reversable kind.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        return null;
      case WagerTransactionKind.Rollback:
        return rollbackDirectionFor(reference);
      default: {
        const exhaustive: never = this.kind;
        throw new InvalidReferenceError(`unknown transaction kind: ${String(exhaustive)}`);
      }
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${transition} from terminal status ${this._status} (transaction ${this.id})`,
      );
    }
  }

  private static assertPositiveAmount(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidAmountError(`transaction amount must be positive, got ${money.toString()}`);
    }
  }

  private static assertRequiredFields(props: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId?: string;
    gameId?: string;
    kind: WagerTransactionKind;
  }): void {
    const fields: Array<[string, string | undefined]> = [
      ['id', props.id],
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['payloadHash', props.payloadHash],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
      // round/game are meaningless for the internal OPENING transaction
      ...(props.kind === WagerTransactionKind.Opening
        ? []
        : ([['roundId', props.roundId], ['gameId', props.gameId]] as Array<[string, string | undefined]>)),
    ];
    for (const [label, value] of fields) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidTransactionError(`${label} must be a non-empty string`);
      }
    }
  }
}

function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

/** ROLLBACK inverts its reference's direction. BET/WIN/REFUND are reversible; LOSS, OPENING and ROLLBACK are not. */
function rollbackDirectionFor(reference: WagerTransaction | undefined): LedgerDirection {
  if (!reference) {
    throw new InvalidReferenceError('ROLLBACK requires a resolved reference to invert its direction');
  }
  switch (reference.kind) {
    case WagerTransactionKind.Bet:
      return LedgerDirection.Credit;
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      return LedgerDirection.Debit;
    case WagerTransactionKind.Loss:
      throw new InvalidReferenceError(`ROLLBACK cannot reference a LOSS (reference ${reference.id})`);
    case WagerTransactionKind.Opening:
    case WagerTransactionKind.Rollback:
      throw new InvalidReferenceError(`ROLLBACK cannot reference a ${reference.kind} (reference ${reference.id})`);
    default: {
      const exhaustive: never = reference.kind;
      throw new DomainError(`unknown reference kind: ${String(exhaustive)}`);
    }
  }
}
