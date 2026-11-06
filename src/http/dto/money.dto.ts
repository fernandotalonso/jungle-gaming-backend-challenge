import { Matches } from 'class-validator';

/**
 * Money on the wire: decimal string with FIXED scale 2, positive, and an
 * ISO-4217 currency. Negatives are rejected at the contract level (README 6.1)
 * — the domain type allows them internally for deltas/differences only.
 */
export class MoneyDto {
  @Matches(/^\d+\.\d{2}$/, {
    message: 'amount must be a positive decimal string with exactly 2 decimal places (e.g. "25.00")',
  })
  amount!: string;

  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code (3 uppercase letters)' })
  currency!: string;
}
