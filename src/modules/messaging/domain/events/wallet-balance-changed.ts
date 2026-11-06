import { generateId } from '../../../../shared/ids';
import type { EventContext } from '../integration-event';
import { IntegrationEvent } from '../integration-event';
import type { LedgerDirection } from '../../../../shared/domain/ledger-direction';
import type { MoneyProps } from '../../../../shared/domain/money';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  constructor(props: {
    eventId?: string;
    aggregateId: string;
    data: WalletBalanceChangedData;
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

  static from(
    wallet: { id: string; version: number },
    entry: {
      transactionId: string;
      direction: LedgerDirection;
      money: MoneyProps;
      balanceBefore: MoneyProps;
      balanceAfter: MoneyProps;
    },
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
        walletVersion: wallet.version,
      },
    });
  }
}
