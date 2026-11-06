import type { Db } from '../../../../shared/application/db';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** opaque cursor for the next page, null when exhausted */
  nextCursor: string | null;
}

export interface ListLedgerOptions {
  limit: number;
  cursor?: string;
}

export interface LedgerRepository {
  /** Must run inside an active transaction. */
  insert(entry: WalletLedgerEntry, db: Db): Promise<void>;
  /** Chronological keyset pagination via stable opaque cursor. */
  listByWalletId(walletId: string, options: ListLedgerOptions, db?: Db): Promise<LedgerPage>;
}

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
