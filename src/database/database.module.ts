import { MikroORM } from '@mikro-orm/core';
import { ConfigService } from '@nestjs/config';
import { Global, Inject, Module, type Provider } from '@nestjs/common';
import { buildMikroOrmOptions } from '../config/mikro-orm.options';

export const MIKRO_ORM = Symbol('MIKRO_ORM');

export function injectOrm(): ParameterDecorator {
  return Inject(MIKRO_ORM);
}

/**
 * Owns the MikroORM instance. Initialization is lazy (`initSync`: the database
 * connection opens on first use) so the process can boot even when PostgreSQL
 * is temporarily unavailable — the readiness health check connects on demand
 * and reports the real state.
 */
const ormProvider: Provider = {
  provide: MIKRO_ORM,
  inject: [ConfigService],
  useFactory: (config: ConfigService): MikroORM =>
    MikroORM.initSync(
      buildMikroOrmOptions({
        databaseUrl: config.get<string>('DATABASE_URL'),
        debug: config.get<string>('MIKRO_ORM_DEBUG') === 'true',
      }),
    ),
};

@Global()
@Module({
  providers: [ormProvider],
  exports: [MIKRO_ORM],
})
export class DatabaseModule {}
