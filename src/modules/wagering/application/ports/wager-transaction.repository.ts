import type { Db } from '../../../../shared/application/db';
import type { WagerTransaction } from '../../domain/wager-transaction';

export interface WagerTransactionRepository {
  /** Must run inside an active transaction. */
  insert(tx: WagerTransaction, db: Db): Promise<void>;
  /** Persists state transitions (status, failure code, reference attempts...). Must run inside an active transaction. */
  update(tx: WagerTransaction, db: Db): Promise<void>;
  findById(id: string, db?: Db): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string, db?: Db): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string, db?: Db): Promise<WagerTransaction | null>;
  /** PENDING_REFERENCE transactions due for another check (backoff respected). Must run inside a transaction. */
  findPendingReferences(db: Db, now: Date, limit: number): Promise<WagerTransaction[]>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
