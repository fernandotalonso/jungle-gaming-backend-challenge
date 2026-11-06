import { MikroORM } from '@mikro-orm/core';
import type { Db } from '../../application/db';
import type { UnitOfWork } from '../../application/ports/unit-of-work';

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (db: Db) => Promise<T>): Promise<T> {
    // each run forks a fresh EntityManager bound to its own transaction
    return this.orm.em.fork().transactional(async (em) => work(em as Db));
  }
}
