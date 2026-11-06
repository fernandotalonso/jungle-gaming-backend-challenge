import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/modules/messaging/domain/events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../../../src/modules/messaging/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/modules/messaging/domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../../../src/modules/messaging/domain/events/wager-transaction-pending-reference';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../src/shared/domain/ledger-direction';
import { Money } from '../../../src/shared/domain/money';

const CTX = { correlationId: 'corr-123', causationId: 'tx-1', occurredAt: new Date('2026-11-06T10:00:00Z') };

function betTransaction() {
  return WagerTransaction.create({
    id: 'tx-internal-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  });
}

describe('WalletBalanceChanged', () => {
  it('carries type identity on the class, not loose strings', () => {
    const event = WalletBalanceChanged.from(
      { id: 'wallet-1', version: 3 },
      {
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
      },
      CTX,
    );

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.correlationId).toBe('corr-123');
    expect(event.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(event.data.walletVersion).toBe(3);
  });

  it('serializes to the stable envelope (occurredAt as ISO-8601)', () => {
    const json = WalletBalanceChanged.from(
      { id: 'wallet-1', version: 2 },
      {
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '90.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
      },
      CTX,
    ).toJSON();

    expect(json).toEqual({
      eventId: expect.any(String),
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-123',
      causationId: 'tx-1',
      occurredAt: '2026-11-06T10:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '90.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('JSON payload is JSON-stable and hashable', () => {
    const json = WalletBalanceChanged.from(
      { id: 'wallet-1', version: 1 },
      {
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '1.00', currency: 'BRL' },
        balanceBefore: { amount: '2.00', currency: 'BRL' },
        balanceAfter: { amount: '1.00', currency: 'BRL' },
      },
      CTX,
    ).toJSON();
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

describe('event envelope variants', () => {
  it('WagerTransactionProcessed serializes processed transaction data', () => {
    const tx = betTransaction();
    tx.markProcessed(undefined, new Date('2026-11-06T10:00:05Z'));
    const json = WagerTransactionProcessed.from(tx, CTX).toJSON();

    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.data.kind).toBe('BET');
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.processedAt).toBe('2026-11-06T10:00:05.000Z');
  });

  it('WagerTransactionRejected requires and serializes the failure code', () => {
    const tx = betTransaction();
    tx.reject(FailureCode.INSUFFICIENT_FUNDS);
    const json = WagerTransactionRejected.from(tx, 'balance would go negative', CTX).toJSON();

    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(json.data.reason).toBe('balance would go negative');
  });

  it('WagerTransactionRejected.from throws when failureCode is missing', () => {
    const tx = betTransaction();
    expect(() => WagerTransactionRejected.from(tx, 'no code', CTX)).toThrow(TypeError);
  });

  it('WagerTransactionPendingReference carries the awaited reference', () => {
    const tx = WagerTransaction.create({
      id: 'tx-internal-2',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-456',
      idempotencyKey: 'provider-a:transaction-456',
      payloadHash: 'b'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'transaction-123',
    });
    tx.markPendingReference();

    const json = WagerTransactionPendingReference.from(tx, { correlationId: 'corr-1' }).toJSON();
    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data.referenceExternalTransactionId).toBe('transaction-123');
    expect(json.causationId).toBeUndefined(); // omitted when absent
  });

  it('envelope requires a non-empty correlationId', () => {
    const tx = betTransaction();
    expect(() => WagerTransactionProcessed.from(tx, { correlationId: '' })).toThrow(TypeError);
  });
});
