import type { Options } from '@mikro-orm/postgresql';
import { buildMikroOrmOptions } from './src/config/mikro-orm.options';

const config: Options = buildMikroOrmOptions({
  databaseUrl: process.env.DATABASE_URL,
  debug: process.env.MIKRO_ORM_DEBUG === 'true',
});

export default config;
