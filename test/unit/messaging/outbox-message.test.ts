import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { InvalidMessageStateError } from '../../../src/shared/domain/errors';
import { WalletBalanceChanged } from '../../../src/modules/messaging/domain/events/wallet-balance-changed';
import { LedgerDirection } from '../../../src/shared/domain/ledger-direction';

function makeEvent() {
  return WalletBalanceChanged.from(
    { id: 'wallet-1', version: 3 },
    {
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    },
    { correlationId: 'corr-1', causationId: 'tx-1' },
  );
}

describe('OutboxMessage.enqueue', () => {
  it('stores the event envelope as payload, pending and immediately due', () => {
    const event = makeEvent();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date())).toBe(true);
    expect(message.publishedAt).toBeUndefined();
  });
});

describe('OutboxMessage scheduleRetry backoff', () => {
  it('doubles the delay up to the cap', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    let now = new Date('2026-11-06T10:00:00Z');

    const expectedDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];

    for (const expectedDelay of expectedDelaysMs) {
      message.scheduleRetry(now);
      expect(message.attempts).toBeLessThanOrEqual(expectedDelaysMs.length);
      const next = message.nextAttemptAt!;
      expect(next.getTime() - now.getTime()).toBe(expectedDelay);
      expect(message.isDue(now)).toBe(false);
      expect(message.isDue(new Date(next.getTime()))).toBe(true);
      now = new Date(next.getTime());
    }
    expect(message.attempts).toBe(expectedDelaysMs.length);
  });

  it('cannot reschedule or publish twice', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    message.markPublished(new Date());

    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date())).toBe(false);
    expect(() => message.markPublished(new Date())).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(new Date())).toThrow(InvalidMessageStateError);
  });
});

describe('OutboxMessage.rehydrate', () => {
  it('reconstructs from persistence state', () => {
    const message = OutboxMessage.rehydrate({
      id: '0192f2a0-0000-7000-8000-000000000009',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'e1', eventType: 'WalletBalanceChanged', version: 1 },
      occurredAt: '2026-11-06T10:00:00.000Z',
      attempts: 3,
      nextAttemptAt: '2026-11-06T10:08:00.000Z',
      publishedAt: null,
    });

    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date('2026-11-06T10:07:59.000Z'))).toBe(false);
    expect(message.isDue(new Date('2026-11-06T10:08:00.000Z'))).toBe(true);
  });

  it('reconstructs a published message', () => {
    const message = OutboxMessage.rehydrate({
      id: 'x',
      aggregateId: 'a',
      eventType: 'WalletBalanceChanged',
      payload: {},
      occurredAt: new Date(),
      attempts: 1,
      nextAttemptAt: null,
      publishedAt: '2026-11-06T10:00:05.000Z',
    });
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt?.toISOString()).toBe('2026-11-06T10:00:05.000Z');
  });
});
