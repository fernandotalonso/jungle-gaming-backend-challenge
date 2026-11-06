import { toDate } from '../../../shared/domain/coerce';
import type { DateLike } from '../../../shared/domain/date-like';
import { DomainError, InvalidMessageStateError } from '../../../shared/domain/errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: DateLike;
  processedAt?: DateLike | null;
}

/**
 * Persistent inbox record. Uniqueness is enforced by the database on
 * (consumerName, messageId) — inserting twice fails at the SQL level, making
 * the deduplication guarantee independent of application code or cache.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'messageId');
    assertNonEmpty(props.consumerName, 'consumerName');
    assertNonEmpty(props.payloadHash, 'payloadHash');

    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt ?? new Date());
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    assertNonEmpty(state.messageId, 'messageId');
    assertNonEmpty(state.consumerName, 'consumerName');

    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      toDate(state.receivedAt),
      state.processedAt == null ? undefined : toDate(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`inbox message ${this.messageId} is already processed`);
    }
    this._processedAt = at;
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(`${label} must be a non-empty string`);
  }
}
