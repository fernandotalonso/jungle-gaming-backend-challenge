import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { DomainError, InvalidMessageStateError } from '../../../src/shared/domain/errors';

const BASE = {
  messageId: 'msg-123',
  consumerName: 'wager-transactions-consumer',
  payloadHash: 'a'.repeat(64),
} as const;

describe('InboxMessage.receive', () => {
  it('starts unprocessed with a receivedAt timestamp', () => {
    const receivedAt = new Date('2026-11-06T10:00:00Z');
    const message = InboxMessage.receive({ ...BASE, receivedAt });

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.receivedAt).toBe(receivedAt);
  });

  it('defaults receivedAt to now', () => {
    const before = new Date();
    const message = InboxMessage.receive({ ...BASE });
    expect(message.receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('rejects empty identifiers', () => {
    expect(() => InboxMessage.receive({ ...BASE, messageId: '' })).toThrow(DomainError);
    expect(() => InboxMessage.receive({ ...BASE, consumerName: '' })).toThrow(DomainError);
    expect(() => InboxMessage.receive({ ...BASE, payloadHash: '' })).toThrow(DomainError);
  });
});

describe('InboxMessage transitions', () => {
  it('marks processed exactly once', () => {
    const at = new Date('2026-11-06T10:01:00Z');
    const message = InboxMessage.receive({ ...BASE });
    message.markProcessed(at);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(at);
    expect(() => message.markProcessed(new Date())).toThrow(InvalidMessageStateError);
  });
});

describe('InboxMessage.rehydrate', () => {
  it('reconstructs a processed message from persistence', () => {
    const message = InboxMessage.rehydrate({
      ...BASE,
      receivedAt: '2026-11-06T10:00:00.000Z',
      processedAt: '2026-11-06T10:01:00.000Z',
    });
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe('2026-11-06T10:01:00.000Z');
  });

  it('reconstructs an unprocessed message', () => {
    const message = InboxMessage.rehydrate({
      ...BASE,
      receivedAt: new Date(),
      processedAt: null,
    });
    expect(message.isProcessed()).toBe(false);
  });
});
