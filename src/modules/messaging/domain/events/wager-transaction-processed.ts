import { generateId } from '../../../../shared/ids';
import type { EventContext } from '../integration-event';
import { IntegrationEvent } from '../integration-event';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyPropsLike;
  processedAt: string;
}

type MoneyPropsLike = { amount: string; currency: string };

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  constructor(props: {
    eventId?: string;
    aggregateId: string;
    data: WagerTransactionProcessedData;
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

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        processedAt: (tx.processedAt ?? new Date()).toISOString(),
      },
    });
  }
}
