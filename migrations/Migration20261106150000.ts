import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema — all invariants from the challenge spec (section 5.9) are
 * enforced at the database level, not only in application code:
 *
 * - wallets: balance CHECK >= 0, UNIQUE (player_id, currency)
 * - wager_transactions: UNIQUE idempotency_key, UNIQUE (provider, external id),
 *   failure_code required for terminal failure states, reversal must resolve
 *   its reference
 * - wallet_ledger_entries: UNIQUE (transaction_id, wallet_id), arithmetic
 *   CHECK, append-only via trigger
 * - inbox_messages: composite PK (consumer_name, message_id)
 * - outbox_messages: partial index for due publications
 */
export class Migration20261106150000 extends Migration {
  override async up(): Promise<void> {
    await this.execute(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id varchar(64) NOT NULL,
        currency varchar(3) NOT NULL,
        balance numeric(14,2) NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      )
    `);

    await this.execute(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(64) NOT NULL,
        external_transaction_id varchar(128) NOT NULL,
        idempotency_key varchar(200) NOT NULL,
        payload_hash varchar(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id varchar(64) NOT NULL,
        round_id varchar(128) NOT NULL,
        game_id varchar(128) NOT NULL,
        kind varchar(16) NOT NULL,
        amount numeric(14,2) NOT NULL,
        currency varchar(3) NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id uuid,
        status varchar(20) NOT NULL,
        failure_code varchar(64),
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_check_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT wager_transactions_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_transactions_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_transactions_failure_code_required CHECK (
          status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL
        ),
        CONSTRAINT wager_transactions_reversal_needs_reference CHECK (
          status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(id),
        CONSTRAINT wager_transactions_reference_fk FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id)
      )
    `);

    await this.execute(`
      CREATE INDEX idx_wager_tx_reference_lookup
        ON wager_transactions (provider_id, reference_external_transaction_id)
    `);
    await this.execute(`
      CREATE INDEX idx_wager_tx_wallet ON wager_transactions (wallet_id)
    `);
    await this.execute(`
      CREATE INDEX idx_wager_tx_pending_reference
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    await this.execute(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction varchar(6) NOT NULL,
        amount numeric(14,2) NOT NULL,
        currency varchar(3) NOT NULL,
        balance_before numeric(14,2) NOT NULL,
        balance_after numeric(14,2) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        ),
        CONSTRAINT wallet_ledger_entries_tx_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(id),
        CONSTRAINT wallet_ledger_entries_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions(id)
      )
    `);

    await this.execute(`
      CREATE INDEX idx_ledger_wallet_cursor
        ON wallet_ledger_entries (wallet_id, created_at, id)
    `);

    // Defense in depth: the ledger is append-only for every role, including
    // the table owner. DELETE/TRUNCATE via maintenance requires dropping the
    // trigger first — a deliberate, auditable act.
    await this.execute(`
      CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (UPDATE/DELETE are forbidden)';
      END;
      $$
    `);
    await this.execute(`
      CREATE TRIGGER trg_wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()
    `);

    await this.execute(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(128) NOT NULL,
        message_id varchar(256) NOT NULL,
        payload_hash varchar(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      )
    `);

    await this.execute(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id varchar(128) NOT NULL,
        event_type varchar(128) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0)
      )
    `);

    await this.execute(`
      CREATE INDEX idx_outbox_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    await this.execute('DROP INDEX IF EXISTS idx_outbox_due');
    await this.execute('DROP TABLE IF EXISTS outbox_messages');
    await this.execute('DROP TABLE IF EXISTS inbox_messages');
    await this.execute('DROP TRIGGER IF EXISTS trg_wallet_ledger_entries_append_only ON wallet_ledger_entries');
    await this.execute('DROP FUNCTION IF EXISTS prevent_ledger_mutation');
    await this.execute('DROP INDEX IF EXISTS idx_ledger_wallet_cursor');
    await this.execute('DROP TABLE IF EXISTS wallet_ledger_entries');
    await this.execute('DROP INDEX IF EXISTS idx_wager_tx_pending_reference');
    await this.execute('DROP INDEX IF EXISTS idx_wager_tx_wallet');
    await this.execute('DROP INDEX IF EXISTS idx_wager_tx_reference_lookup');
    await this.execute('DROP TABLE IF EXISTS wager_transactions');
    await this.execute('DROP TABLE IF EXISTS wallets');
  }
}
