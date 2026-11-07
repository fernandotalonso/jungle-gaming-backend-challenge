import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/reconcile-wallet.use-case';
import { Money } from '../../src/shared/domain/money';

/**
 * The final invariant of every concurrency test (README 13):
 *   wallet.balance == saldo reconstruído pelo ledger
 * plus: never negative, every stored entry arithmetically balanced, and the
 * reconciliation report confirming it.
 */
export async function expectLedgerConsistency(orm: MikroORM, walletId: string): Promise<void> {
  const wallets = new MikroOrmWalletRepository(orm);
  const ledger = new MikroOrmLedgerRepository(orm);

  const wallet = await wallets.findById(walletId);
  expect(wallet).not.toBeNull();
  expect(wallet!.balance.isNegative()).toBe(false);

  let reconstructed = Money.zero(wallet!.currency);
  let entries = 0;
  let cursor: string | undefined;
  do {
    const page = await ledger.listByWalletId(walletId, { limit: 200, cursor });
    for (const entry of page.items) {
      reconstructed =
        entry.direction === 'CREDIT' ? reconstructed.add(entry.money) : reconstructed.subtract(entry.money);
      expect(entry.balanceAfter.isNegative()).toBe(false);
      expect(entry.isBalanced()).toBe(true);
      entries += 1;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  expect(wallet!.balance.toString()).toBe(reconstructed.toString());

  const reconciliation = await new ReconcileWalletUseCase({ wallets, ledger }).execute(walletId);
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.checkedEntries).toBe(entries);
}
