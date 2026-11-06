import { Decimal } from './decimal';
import { CurrencyMismatchError, MoneyValidationError } from './errors';

export interface MoneyProps {
  /** decimal string with fixed scale 2, e.g. "25.00" */
  amount: string;
  /** ISO-4217 code, e.g. "BRL" */
  currency: string;
}

const AMOUNT_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value backed by an exact decimal. Every operation returns
 * a new instance; the internal representation is never mutated.
 *
 * Validation contract:
 * - `amount` must be a plain decimal string (no scientific notation, no
 *   whitespace, no sign prefix other than "-", at most 2 decimal places).
 * - Negative values are allowed at the domain level (needed for reversal
 *   deltas and reconciliation differences); contracts that receive values
 *   from the outside world (API payload, SQS message) must reject them before
 *   reaching the domain — enforced by DTO validation and by factories that
 *   require positive amounts (wallet movements, transaction amounts).
 * - Serialization always produces exactly 2 decimal places ("25" -> "25.00").
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string' || amount.length === 0) {
      throw new MoneyValidationError(`amount must be a non-empty decimal string, got: ${String(amount)}`);
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new MoneyValidationError(
        `amount "${amount}" is not a valid decimal string (max 2 decimal places, no scientific notation)`,
      );
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new MoneyValidationError(`currency "${String(currency)}" must be an ISO-4217 code (3 uppercase letters)`);
    }

    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.sub(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.eq(0);
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    // normalize signed zero so serialization is always "0.00"
    const amount = this.isZero() ? '0.00' : this.value.toFixed(2);
    return { amount, currency: this.currency };
  }

  toString(): string {
    return this.toJSON().amount;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `currency mismatch: ${this.currency} !== ${other.currency}`,
      );
    }
  }
}
