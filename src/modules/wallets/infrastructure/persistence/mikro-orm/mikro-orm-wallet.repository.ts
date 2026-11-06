import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/core';
import type { Db } from '../../../../../shared/application/db';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import { Wallet } from '../../../domain/wallet';
import { WalletEntity } from './wallet.entity';

function toDomain(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: { amount: entity.balance, currency: entity.currency },
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

function toEntity(wallet: Wallet): WalletEntity {
  const entity = new WalletEntity();
  entity.id = wallet.id;
  entity.playerId = wallet.playerId;
  entity.currency = wallet.currency;
  entity.balance = wallet.balance.toString();
  entity.version = wallet.version;
  entity.createdAt = wallet.createdAt;
  entity.updatedAt = wallet.updatedAt;
  return entity;
}

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly orm: MikroORM) {}

  async insert(wallet: Wallet, db: Db): Promise<void> {
    db.persist(toEntity(wallet));
    // explicit flush: entities carry no declared FK relations, so insert
    // ordering is this adapter's responsibility
    await db.flush();
  }

  async update(wallet: Wallet, db: Db): Promise<void> {
    // the row is locked by the use case (findByIdForUpdate); raw UPDATE keeps
    // the write minimal and independent of identity-map state
    await db.execute('UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ?', [
      wallet.balance.toString(),
      wallet.version,
      wallet.updatedAt,
      wallet.id,
    ]);
  }

  async findById(id: string, db?: Db): Promise<Wallet | null> {
    const entity = await (db ?? this.orm.em.fork()).findOne(WalletEntity, { id });
    return entity ? toDomain(entity) : null;
  }

  async findByIdForUpdate(id: string, db: Db): Promise<Wallet | null> {
    const entity = await db.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? toDomain(entity) : null;
  }
}
