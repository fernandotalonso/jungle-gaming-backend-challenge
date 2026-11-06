import type { EntityManager } from '@mikro-orm/core';

/**
 * Transaction handle passed to repository methods. It is intentionally the
 * ORM's EntityManager: the UnitOfWork port opens the transaction and hands
 * the bound EntityManager to the use case, which forwards it to every
 * repository participating in the same SQL transaction (inbox + wallet +
 * ledger + outbox commit atomically together).
 *
 * `execute` is MikroORM's transaction-bound raw SQL API. It exists at runtime
 * in 6.6 but the published typings omit it — declared here so raw SQL stays
 * explicit and type-checked. (NOTE: `em.getConnection()` returns the pooled
 * driver connection, NOT the transaction one — raw SQL through it breaks
 * transactional semantics.)
 *
 * Trade-off (documented in ARCHITECTURE.md): the port is repository-level,
 * not storage-engine-level — swapping the ORM rewrites adapters, not use
 * cases; unit tests replace it with in-memory fakes.
 */
export type Db = EntityManager & {
  execute<T = unknown>(sql: string, params?: unknown[], method?: 'all' | 'get' | 'run'): Promise<T>;
};

