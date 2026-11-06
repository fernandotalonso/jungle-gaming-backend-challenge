import type { Db } from '../../../../shared/application/db';
import type { Wallet } from '../../domain/wallet';

export interface WalletRepository {
  /** Must run inside an active transaction. */
  insert(wallet: Wallet, db: Db): Promise<void>;
  /** Persists balance/version/updatedAt after mutations. Must run inside an active transaction. */
  update(wallet: Wallet, db: Db): Promise<void>;
  findById(id: string, db?: Db): Promise<Wallet | null>;
  /** Row lock (SELECT ... FOR UPDATE) — the concurrency unit of the system. Must run inside a transaction. */
  findByIdForUpdate(id: string, db: Db): Promise<Wallet | null>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
