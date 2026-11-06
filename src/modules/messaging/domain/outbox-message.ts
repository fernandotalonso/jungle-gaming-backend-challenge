import { generateId } from '../../../shared/ids';
import { toDate } from '../../../shared/domain/coerce';
import type { DateLike } from '../../../shared/domain/date-like';
import { DomainError, InvalidMessageStateError } from '../../../shared/domain/errors';
import type { IntegrationEvent } from './integration-event';

export interface EnqueueEventProps {
  event: IntegrationEvent<unknown>;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: DateLike;
  attempts: number;
  nextAttemptAt?: DateLike | null;
  publishedAt?: DateLike | null;
}

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Transactional outbox record. The payload is the serialized integration
 * event envelope — stable, versioned JSON. Publication retries use
 * exponential backoff with a cap; an outbox message is never discarded.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** Persists the event envelope as a pending publication. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      generateId(),
      event.aggregateId,
      event.eventType,
      // the envelope is a plain JSON object at this boundary
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      event.occurredAt, // due immediately
    );
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    assertNonEmpty(state.id, 'id');
    assertNonEmpty(state.aggregateId, 'aggregateId');
    assertNonEmpty(state.eventType, 'eventType');

    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      toDate(state.occurredAt),
      state.attempts,
      state.nextAttemptAt == null ? undefined : toDate(state.nextAttemptAt),
      state.publishedAt == null ? undefined : toDate(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`outbox message ${this.id} is already published`);
    }
    this._publishedAt = at;
  }

  /** Increments attempts and computes the next attempt with exponential backoff. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`published outbox message ${this.id} cannot be rescheduled`);
    }
    this._attempts += 1;
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (this._attempts - 1), MAX_RETRY_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(`${label} must be a non-empty string`);
  }
}
