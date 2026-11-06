import { Money, type MoneyProps } from '../../../shared/domain/money';
import { LedgerDirection } from '../../../shared/domain/ledger-direction';
import type { LedgerRepository } from './ports/ledger.repository';
import type { WalletRepository } from './ports/wallet.repository';
import { WalletNotFoundError } from './wallet-errors';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

interface Deps {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  onDivergence?: (result: ReconciliationResult) => void;
}

/**
 * Recomputes the wallet balance from the ledger and compares it with the
 * stored balance (README 9). Divergences are NEVER silently corrected: they
 * are reported in the result and surfaced through `onDivergence` (logged and
 * counted as a metric by the infrastructure wiring — README 12).
 */
export class ReconcileWalletUseCase {
  constructor(private readonly deps: Deps) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const wallet = await this.deps.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    let calculated = Money.zero(wallet.currency);
    let checkedEntries = 0;
    let cursor: string | undefined;

    do {
      const page = await this.deps.ledger.listByWalletId(walletId, { limit: 200, cursor });
      for (const entry of page.items) {
        calculated =
          entry.direction === LedgerDirection.Credit
            ? calculated.add(entry.money)
            : calculated.subtract(entry.money);
        checkedEntries += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const difference = calculated.subtract(wallet.balance);
    const result: ReconciliationResult = {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries,
    };

    if (!result.consistent) {
      this.deps.onDivergence?.(result);
    }
    return result;
  }
}
