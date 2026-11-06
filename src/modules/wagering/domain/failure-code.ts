/**
 * Stable, machine-readable failure codes carried by REJECTED/FAILED
 * transactions. The taxonomy is part of the provider contract: it must be
 * enough for a provider to decide whether to retry, fix the payload, or give
 * up — without interpreting free-text messages.
 *
 * Rule (README 7.2): every rejection carries exactly one code.
 */
export enum FailureCode {
  /** BET rejected because the wallet balance could not cover it. Retry after top-up may succeed. */
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',

  /**
   * REFUND/ROLLBACK that would make the balance negative (e.g. reversing a
   * WIN already spent by a BET). Operationally distinct from a failed BET —
   * the money exists but is committed elsewhere. Retry will not succeed.
   */
  INSUFFICIENT_FUNDS_FOR_REVERSAL = 'INSUFFICIENT_FUNDS_FOR_REVERSAL',

  /** Referenced transaction never arrived (reference TTL exhausted). */
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',

  /** The referenced transaction was already reverted by the same kind of operation. */
  REFERENCE_ALREADY_REVERSED = 'REFERENCE_ALREADY_REVERSED',

  /** REFUND/ROLLBACK referencing a transaction kind it is not allowed to reverse. */
  REFERENCE_KIND_MISMATCH = 'REFERENCE_KIND_MISMATCH',

  /** Reference resolves to a transaction of another provider/player/wallet/currency/round. */
  REFERENCE_CONTEXT_MISMATCH = 'REFERENCE_CONTEXT_MISMATCH',

  /** REFUND/ROLLBACK amount differs from the referenced transaction amount. */
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',

  /** Transaction currency differs from the wallet currency. */
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',

  /** Wallet referenced by the transaction does not exist (yet). Retry may succeed. */
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',

  /** Payload amount is not a valid positive monetary value. Fix the payload. */
  INVALID_AMOUNT = 'INVALID_AMOUNT',

  /** Reference lookup produced an irreversible infrastructure error (audited, terminal). */
  REFERENCE_LOOKUP_FAILED = 'REFERENCE_LOOKUP_FAILED',
}
