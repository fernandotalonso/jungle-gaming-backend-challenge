import { generateId } from '../../../shared/ids';

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

/** Ambient context propagated from the triggering use case. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

export interface SerializedIntegrationEvent<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Abstract envelope for integration events. `eventType` and `version` live on
 * the concrete type — never on a loose string at the call site. `data`
 * carries serializable props (e.g. MoneyProps), never domain instances, so
 * the outbox payload is stable, versionable JSON.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    if (typeof props.aggregateId !== 'string' || props.aggregateId.length === 0) {
      throw new TypeError('aggregateId must be a non-empty string');
    }
    if (typeof props.correlationId !== 'string' || props.correlationId.length === 0) {
      throw new TypeError('correlationId must be a non-empty string');
    }

    this.eventId = props.eventId ?? generateId();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope serialized into the outbox payload. */
  toJSON(): SerializedIntegrationEvent<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
