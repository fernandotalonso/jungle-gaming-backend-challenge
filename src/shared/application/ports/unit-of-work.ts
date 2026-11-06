import type { Db } from '../../../shared/application/db';

/**
 * Runs `work` inside a single SQL transaction. Everything the use case
 * persists through `db` commits atomically — or nothing does.
 */
export interface UnitOfWork {
  run<T>(work: (db: Db) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
