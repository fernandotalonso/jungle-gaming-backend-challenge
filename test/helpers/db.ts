import { MikroORM } from '@mikro-orm/core';
import { buildMikroOrmOptions } from '../../src/config/mikro-orm.options';
import type { Db } from '../../src/shared/application/db';

let ormPromise: Promise<MikroORM> | null = null;

/** Initializes the ORM against the real PostgreSQL from docker-compose. */
export function getTestOrm(): Promise<MikroORM> {
  if (!ormPromise) {
    ormPromise = (async () => {
      const orm = await MikroORM.init(
        buildMikroOrmOptions({ databaseUrl: process.env.DATABASE_URL }),
      );
      // integration tests require the schema to be up to date
      await orm.getMigrator().up();
      return orm;
    })();
  }
  return ormPromise;
}

export async function truncateAll(orm: MikroORM): Promise<void> {
  // TRUNCATE bypasses the row-level append-only trigger (it is not DELETE)
  await (orm.em as Db).execute(
    'TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages CASCADE',
  );
}
