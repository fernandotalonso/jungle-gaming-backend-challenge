import { describe, expect, it } from 'bun:test';
import type { CreateWagerTransactionProps } from '../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import {
  InvalidAmountError,
  InvalidReferenceError,
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../../src/shared/domain/errors';
import { LedgerDirection } from '../../../src/shared/domain/ledger-direction';
import { Money } from '../../../src/shared/domain/money';

const BASE = {
  id: 'tx-internal-1',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
} as const;

function build(kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.create({
    ...BASE,
    kind,
    ...overrides,
  });
}

describe('WagerTransaction.create', () => {
  it('is born PENDING', () => {
    const tx = build(WagerTransactionKind.Bet);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
  });

  it('rejects the internal OPENING kind', () => {
    expect(() => build(WagerTransactionKind.Opening)).toThrow(InvalidTransactionError);
  });

  it('requires referenceExternalTransactionId for REFUND and ROLLBACK', () => {
    expect(() => build(WagerTransactionKind.Refund)).toThrow(InvalidTransactionError);
    expect(() => build(WagerTransactionKind.Rollback)).toThrow(InvalidTransactionError);

    const refund = build(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'transaction-123',
    });
    expect(refund.requiresReference()).toBe(true);
    expect(refund.referenceExternalTransactionId).toBe('transaction-123');
  });

  it('WIN reference is optional', () => {
    expect(build(WagerTransactionKind.Win).requiresReference()).toBe(false);
    expect(build(WagerTransactionKind.Win, { referenceExternalTransactionId: 'transaction-123' })).toBeDefined();
  });

  it('rejects non-positive amounts', () => {
    expect(() =>
      build(WagerTransactionKind.Bet, {
        money: Money.zero('BRL'),
      }),
    ).toThrow(InvalidAmountError);
    expect(() =>
      build(WagerTransactionKind.Bet, {
        money: Money.from({ amount: '-1.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidAmountError);
  });

  it('rejects missing required fields', () => {
    for (const field of [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      const props = { ...BASE, kind: WagerTransactionKind.Bet, [field]: '' };
      expect(() => WagerTransaction.create(props)).toThrow(InvalidTransactionError);
    }
  });
});

describe('WagerTransaction transitions', () => {
  it('PENDING -> PROCESSED via markProcessed', () => {
    const at = new Date('2026-11-06T12:00:00Z');
    const tx = build(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, at);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(at);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  it('markProcessed stores the resolved reference id', () => {
    const tx = build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'transaction-123' });
    tx.markProcessed('internal-bet-id', new Date());
    expect(tx.referenceTransactionId).toBe('internal-bet-id');
  });

  it('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const tx = build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'ref-1' });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('ref-internal', new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  it('markPendingReference requires PENDING', () => {
    const tx = build(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('PENDING -> REJECTED carries a failureCode', () => {
    const tx = build(WagerTransactionKind.Bet);
    tx.reject(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING -> FAILED carries a failureCode', () => {
    const tx = build(WagerTransactionKind.Bet);
    tx.fail(FailureCode.REFERENCE_LOOKUP_FAILED);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.REFERENCE_LOOKUP_FAILED);
    expect(tx.isTerminal()).toBe(true);
  });

  it('terminal states never transition again', () => {
    const processed = build(WagerTransactionKind.Bet);
    processed.markProcessed(undefined, new Date());
    expect(() => processed.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    expect(() => processed.reject(FailureCode.INVALID_AMOUNT)).toThrow(InvalidTransactionStateError);
    expect(() => processed.fail(FailureCode.INVALID_AMOUNT)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markPendingReference()).toThrow(InvalidTransactionStateError);

    const rejected = build(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.INSUFFICIENT_FUNDS);
    expect(() => rejected.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    expect(() => rejected.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);

    const failed = build(WagerTransactionKind.Bet);
    failed.fail(FailureCode.REFERENCE_LOOKUP_FAILED);
    expect(() => failed.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction queries', () => {
  it('affectsBalance is false only for LOSS', () => {
    expect(build(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(build(WagerTransactionKind.Win).affectsBalance()).toBe(true);
    expect(build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'r' }).affectsBalance()).toBe(true);
    expect(build(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
  });

  it('requiresReference only for REFUND/ROLLBACK', () => {
    expect(build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'r' }).requiresReference()).toBe(true);
    expect(build(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'r' }).requiresReference()).toBe(
      true,
    );
    expect(build(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(build(WagerTransactionKind.Win).requiresReference()).toBe(false);
    expect(build(WagerTransactionKind.Loss).requiresReference()).toBe(false);
  });

  it('matchesPayload compares the stored hash', () => {
    const tx = build(WagerTransactionKind.Bet);
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  it('maps kinds to directions', () => {
    expect(build(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(build(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(build(WagerTransactionKind.Loss).ledgerDirectionFor()).toBeNull();
  });

  it('ROLLBACK inverts the reference direction', () => {
    const bet = build(WagerTransactionKind.Bet); // DEBIT
    const win = build(WagerTransactionKind.Win); // CREDIT
    const refund = build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'r' }); // CREDIT
    const rollback = build(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'r' });

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK requires a resolvable, reversable reference', () => {
    const rollback = build(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'r' });
    expect(() => rollback.ledgerDirectionFor(undefined)).toThrow(InvalidReferenceError);
    expect(() => rollback.ledgerDirectionFor(build(WagerTransactionKind.Loss))).toThrow(InvalidReferenceError);
    expect(() => rollback.ledgerDirectionFor(build(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'r',
    }))).toThrow(InvalidReferenceError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('reconstructs persisted state without revalidating transitions', () => {
    const tx = WagerTransaction.rehydrate({
      ...BASE,
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'transaction-123',
      createdAt: '2026-11-06T09:00:00.000Z',
      status: 'PROCESSED',
      referenceTransactionId: 'bet-internal-id',
      failureCode: null,
      processedAt: '2026-11-06T09:05:00.000Z',
    });

    expect(tx.kind).toBe(WagerTransactionKind.Refund);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe('bet-internal-id');
    expect(tx.processedAt?.toISOString()).toBe('2026-11-06T09:05:00.000Z');
  });

  it('rehydrates a rejected transaction with failure code', () => {
    const tx = WagerTransaction.rehydrate({
      ...BASE,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      createdAt: new Date(),
      status: 'REJECTED',
      referenceTransactionId: null,
      failureCode: 'INSUFFICIENT_FUNDS',
      processedAt: null,
    });
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.processedAt).toBeUndefined();
  });
});
