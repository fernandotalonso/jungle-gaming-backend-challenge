import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Persistence model for the immutable WalletLedgerEntry. Rows are never
 * updated or deleted (append-only enforced by DB trigger in migrations).
 */
@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ fieldName: 'id', columnType: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', columnType: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', columnType: 'uuid' })
  transactionId!: string;

  @Property({ fieldName: 'direction' })
  direction!: string; // DEBIT | CREDIT

  @Property({ fieldName: 'amount', columnType: 'numeric(14,2)' })
  amount!: string;

  @Property({ fieldName: 'currency' })
  currency!: string;

  @Property({ fieldName: 'balance_before', columnType: 'numeric(14,2)' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', columnType: 'numeric(14,2)' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
