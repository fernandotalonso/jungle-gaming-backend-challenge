import { generateId } from '../../../../shared/ids';
import type { EventContext } from '../integration-event';
import { IntegrationEvent } from '../integration-event';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  constructor(props: {
    eventId?: string;
    aggregateId: string;
    data: WagerTransactionPendingReferenceData;
  } & EventContext) {
    super({
      eventId: props.eventId ?? generateId(),
      aggregateId: props.aggregateId,
      correlationId: props.correlationId,
      causationId: props.causationId,
      occurredAt: props.occurredAt ?? new Date(),
      data: props.data,
    });
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        playerId: tx.playerId,
        walletId: tx.walletId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      },
    });
  }
}
