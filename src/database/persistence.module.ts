import type { MikroORM } from '@mikro-orm/core';
import { Global, Module, type Provider } from '@nestjs/common';
import { INBOX_REPOSITORY } from '../modules/messaging/application/ports/inbox.repository';
import { OUTBOX_REPOSITORY } from '../modules/messaging/application/ports/outbox.repository';
import { MikroOrmInboxRepository } from '../modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { WAGER_TRANSACTION_REPOSITORY } from '../modules/wagering/application/ports/wager-transaction.repository';
import { MikroOrmWagerTransactionRepository } from '../modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { LEDGER_REPOSITORY } from '../modules/wallets/application/ports/ledger.repository';
import { WALLET_REPOSITORY } from '../modules/wallets/application/ports/wallet.repository';
import { MikroOrmLedgerRepository } from '../modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from '../modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MIKRO_ORM } from './database.module';
import { UNIT_OF_WORK } from '../shared/application/ports/unit-of-work';
import { MikroOrmUnitOfWork } from '../shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';

function repositoryProvider<T>(token: symbol, factory: (orm: MikroORM) => T): Provider {
  return {
    provide: token,
    inject: [MIKRO_ORM],
    useFactory: factory,
  };
}

/**
 * Registers the MikroORM-backed adapters for every repository port plus the
 * UnitOfWork. Repositories receive the transaction handle (EntityManager)
 * per call, so a use case composes all writes in one SQL transaction.
 */
@Global()
@Module({
  providers: [
    repositoryProvider(WALLET_REPOSITORY, (orm) => new MikroOrmWalletRepository(orm)),
    repositoryProvider(LEDGER_REPOSITORY, (orm) => new MikroOrmLedgerRepository(orm)),
    repositoryProvider(WAGER_TRANSACTION_REPOSITORY, (orm) => new MikroOrmWagerTransactionRepository(orm)),
    repositoryProvider(INBOX_REPOSITORY, () => new MikroOrmInboxRepository()),
    repositoryProvider(OUTBOX_REPOSITORY, () => new MikroOrmOutboxRepository()),
    repositoryProvider(UNIT_OF_WORK, (orm) => new MikroOrmUnitOfWork(orm)),
  ],
  exports: [
    WALLET_REPOSITORY,
    LEDGER_REPOSITORY,
    WAGER_TRANSACTION_REPOSITORY,
    INBOX_REPOSITORY,
    OUTBOX_REPOSITORY,
    UNIT_OF_WORK,
  ],
})
export class PersistenceModule {}
