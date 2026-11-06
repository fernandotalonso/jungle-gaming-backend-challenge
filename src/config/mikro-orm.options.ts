import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';

export interface MikroOrmOptionsInput {
  databaseUrl?: string;
  debug?: boolean;
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
    entities: [],
    // Entities are registered explicitly (never via glob scanning), so an
    // empty list during bootstrap phases is intentional, not a misconfiguration.
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      path: 'migrations',
      snapshot: true,
      transactional: true,
      allOrNothing: true,
    },
    debug: input.debug ?? false,
  };
}
