import { Migration } from '@mikro-orm/migrations';

/**
 * Drops the FK from wager_transactions.wallet_id to wallets.
 *
 * Rejections must remain auditable — including "wallet does not exist"
 * (the rejection record points at a walletId that never existed). Integrity
 * for APPLIED movements is unaffected: ledger entries keep their FKs to both
 * wallets and transactions, and the use case only applies movements on a
 * locked, existing wallet row.
 */
export class Migration20261106170000 extends Migration {
  override async up(): Promise<void> {
    await this.execute('ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_wallet_fk');
  }

  override async down(): Promise<void> {
    await this.execute(
      'ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(id)',
    );
  }
}
