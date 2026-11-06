import { InboxMessageEntity } from '../modules/messaging/infrastructure/persistence/mikro-orm/inbox-message.entity';
import { OutboxMessageEntity } from '../modules/messaging/infrastructure/persistence/mikro-orm/outbox-message.entity';
import { WagerTransactionEntity } from '../modules/wagering/infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { WalletEntity } from '../modules/wallets/infrastructure/persistence/mikro-orm/wallet.entity';
import { WalletLedgerEntryEntity } from '../modules/wallets/infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';

/**
 * Explicit entity registry — no glob scanning, so what participates in the
 * schema is always visible here. Persistence models only; domain classes are
 * never decorated.
 */
export const ENTITIES = [
  WalletEntity,
  WalletLedgerEntryEntity,
  WagerTransactionEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
];
