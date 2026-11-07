import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';
import { ENTITIES } from '../database/entities';

export interface MikroOrmOptionsInput {
  databaseUrl?: string;
  debug?: boolean;
  /** knex pool size — heavier than the default 10 for concurrency tests */
  poolMax?: number;
}

const DEFAULT_DATABASE_URL = 'postgres://jungle:jungle@localhost:5432/jungle_wagering';

/**
 * Central MikroORM configuration, shared by the NestJS bootstrap and the CLI.
 * Entities are registered explicitly per module (no glob scanning) so the
 * runtime never depends on file-system layout.
 */
export function buildMikroOrmOptions(input: MikroOrmOptionsInput = {}): Options {
  return {
    driver: PostgreSqlDriver,
    clientUrl: input.databaseUrl ?? DEFAULT_DATABASE_URL,
    entities: ENTITIES,
    extensions: [Migrator],
    migrations: {
      path: 'migrations',
      // migrations are hand-written (versioned + reversible); no diff snapshot
      snapshot: false,
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 1, max: input.poolMax ?? Number(process.env.PG_POOL_MAX ?? 40) },
    debug: input.debug ?? false,
  };
}
