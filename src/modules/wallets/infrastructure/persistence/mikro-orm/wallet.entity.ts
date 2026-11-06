import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Persistence model for the Wallet aggregate. Pure persistence — no domain
 * behavior. The repository adapter maps to/from the domain via
 * Wallet.rehydrate.
 */
@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ fieldName: 'id', columnType: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id' })
  playerId!: string;

  @Property({ fieldName: 'currency' })
  currency!: string;

  /** exact decimal string, scale 2 — never a JS number */
  @Property({ fieldName: 'balance', columnType: 'numeric(14,2)' })
  balance!: string;

  @Property({ fieldName: 'version' })
  version!: number;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', columnType: 'timestamptz' })
  updatedAt!: Date;
}
