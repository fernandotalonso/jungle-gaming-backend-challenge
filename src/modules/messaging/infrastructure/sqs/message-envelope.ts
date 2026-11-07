import { Money } from '../../../../shared/domain/money';
import { WagerTransactionKind } from '../../../wagering/domain/wager-transaction';
import type { SubmitWagerTransactionCommand } from '../../../wagering/application/submit-wager-transaction.use-case';

export const WAGER_TRANSACTION_REQUESTED_TYPE = 'WagerTransactionRequested';

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SUBMITTABLE_KINDS: string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export class EnvelopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeValidationError';
  }
}

export interface WagerTransactionEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

/**
 * Validates the queue message contract (README 10). Invalid envelopes are
 * PERMANENT errors — the consumer sends them to the DLQ without retrying.
 * The default idempotency key follows the README recommendation
 * "{providerId}:{externalTransactionId}".
 */
export function parseWagerTransactionEnvelope(raw: string): WagerTransactionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new EnvelopeValidationError('message body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new EnvelopeValidationError('message body must be an object');
  }
  const envelope = parsed as Partial<WagerTransactionEnvelope>;

  assertNonEmptyString(envelope.messageId, 'messageId');
  if (envelope.type !== WAGER_TRANSACTION_REQUESTED_TYPE) {
    throw new EnvelopeValidationError(`unsupported message type: ${String(envelope.type)}`);
  }
  assertNonEmptyString(envelope.occurredAt, 'occurredAt');

  const data = envelope.data;
  if (typeof data !== 'object' || data === null) {
    throw new EnvelopeValidationError('data must be an object');
  }

  assertNonEmptyString(data.providerId, 'data.providerId');
  assertNonEmptyString(data.externalTransactionId, 'data.externalTransactionId');
  assertNonEmptyString(data.playerId, 'data.playerId');
  assertNonEmptyString(data.walletId, 'data.walletId');
  assertNonEmptyString(data.roundId, 'data.roundId');
  assertNonEmptyString(data.gameId, 'data.gameId');

  if (typeof data.kind !== 'string' || !SUBMITTABLE_KINDS.includes(data.kind)) {
    throw new EnvelopeValidationError(`data.kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }

  const money = data.money;
  if (typeof money !== 'object' || money === null) {
    throw new EnvelopeValidationError('data.money must be an object');
  }
  if (typeof money.amount !== 'string' || !AMOUNT_PATTERN.test(money.amount)) {
    throw new EnvelopeValidationError('data.money.amount must be a positive decimal string with exactly 2 decimal places');
  }
  if (typeof money.currency !== 'string' || !CURRENCY_PATTERN.test(money.currency)) {
    throw new EnvelopeValidationError('data.money.currency must be an ISO-4217 code');
  }

  if (data.referenceExternalTransactionId !== undefined && typeof data.referenceExternalTransactionId !== 'string') {
    throw new EnvelopeValidationError('data.referenceExternalTransactionId must be a string');
  }
  if (data.idempotencyKey !== undefined && typeof data.idempotencyKey !== 'string') {
    throw new EnvelopeValidationError('data.idempotencyKey must be a string');
  }

  return envelope as WagerTransactionEnvelope;
}

export function envelopeToCommand(envelope: WagerTransactionEnvelope): SubmitWagerTransactionCommand {
  const { data } = envelope;
  return {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind as WagerTransactionKind,
    money: Money.from(data.money),
    referenceExternalTransactionId: data.referenceExternalTransactionId,
  };
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EnvelopeValidationError(`${label} must be a non-empty string`);
  }
}
