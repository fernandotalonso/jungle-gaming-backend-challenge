import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import {
  CurrencyMismatchError,
  MoneyValidationError,
} from '../../../src/shared/domain/errors';

const BRL = { amount: '25.00', currency: 'BRL' } as const;

describe('Money', () => {
  describe('from', () => {
    it('accepts valid decimal strings and normalizes scale to 2', () => {
      expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00');
      expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
      expect(Money.from({ amount: '25.5', currency: 'BRL' }).toString()).toBe('25.50');
      expect(Money.from({ amount: '0.99', currency: 'BRL' }).toString()).toBe('0.99');
      expect(Money.from({ amount: '1000000000.00', currency: 'BRL' }).toString()).toBe('1000000000.00');
    });

    it('rejects empty, non-string and non-numeric inputs', () => {
      const invalid = [
        '',
        'abc',
        'NaN',
        'Infinity',
        '-Infinity',
        '12,50',
        ' 25.00',
        '25.00 ',
        '+25.00',
        '.5',
        '5.',
        '1e5',
        '1E-2',
        '0x10',
      ];
      for (const amount of invalid) {
        expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(MoneyValidationError);
      }
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(MoneyValidationError);
      expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(MoneyValidationError);
    });

    it('rejects more than 2 decimal places', () => {
      for (const amount of ['1.234', '0.001', '10.000']) {
        expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(MoneyValidationError);
      }
    });

    it('rejects invalid currency codes', () => {
      for (const currency of ['', 'brl', 'BR', 'BRLX', 'B1L', 'bRL']) {
        expect(() => Money.from({ amount: '25.00', currency })).toThrow(MoneyValidationError);
      }
    });

    it('allows negative values internally (reversal deltas, reconciliation differences)', () => {
      const money = Money.from({ amount: '-25.00', currency: 'BRL' });
      expect(money.isNegative()).toBe(true);
      expect(money.toString()).toBe('-25.00');
    });
  });

  describe('zero', () => {
    it('creates a zero value for the currency', () => {
      const zero = Money.zero('BRL');
      expect(zero.isZero()).toBe(true);
      expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });
  });

  describe('operations', () => {
    it('adds and subtracts exactly', () => {
      const base = Money.from(BRL);
      expect(base.add(Money.from({ amount: '0.01', currency: 'BRL' })).toString()).toBe('25.01');
      expect(base.subtract(Money.from({ amount: '0.10', currency: 'BRL' })).toString()).toBe('24.90');
      expect(Money.zero('BRL').add(base).toString()).toBe('25.00');
    });

    it('rejects operations between different currencies', () => {
      const brl = Money.from(BRL);
      const usd = Money.from({ amount: '10.00', currency: 'USD' });
      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    it('is immutable — operations return new instances', () => {
      const base = Money.from(BRL);
      const result = base.add(Money.from({ amount: '5.00', currency: 'BRL' }));
      expect(base.toString()).toBe('25.00');
      expect(result.toString()).toBe('30.00');
      expect(Object.isFrozen(base)).toBe(true);
    });

    it('negates', () => {
      expect(Money.from(BRL).negate().toString()).toBe('-25.00');
      expect(Money.from({ amount: '-25.00', currency: 'BRL' }).negate().toString()).toBe('25.00');
    });
  });

  describe('predicates', () => {
    it('classifies zero, positive and negative', () => {
      const zero = Money.zero('BRL');
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);

      const positive = Money.from(BRL);
      expect(positive.isPositive()).toBe(true);
      expect(positive.isZero()).toBe(false);

      const negative = Money.from({ amount: '-0.01', currency: 'BRL' });
      expect(negative.isNegative()).toBe(true);
    });

    it('compares and equals within the same currency', () => {
      const small = Money.from({ amount: '9.99', currency: 'BRL' });
      const large = Money.from({ amount: '10.00', currency: 'BRL' });
      expect(small.isLessThan(large)).toBe(true);
      expect(large.isLessThan(small)).toBe(false);
      expect(small.equals(Money.from({ amount: '9.99', currency: 'BRL' }))).toBe(true);
      expect(small.equals(large)).toBe(false);
      expect(small.equals(Money.from({ amount: '9.99', currency: 'USD' }))).toBe(false);
    });
  });

  describe('serialization', () => {
    it('serializes with fixed scale 2 and stable currency', () => {
      expect(Money.from({ amount: '7.5', currency: 'BRL' }).toJSON()).toEqual({
        amount: '7.50',
        currency: 'BRL',
      });
      expect(Money.from({ amount: '-3.20', currency: 'BRL' }).toString()).toBe('-3.20');
    });

    it('normalizes signed zero on serialization', () => {
      expect(Money.from({ amount: '-0.00', currency: 'BRL' }).toJSON().amount).toBe('0.00');
      expect(Money.zero('BRL').subtract(Money.zero('BRL')).toJSON().amount).toBe('0.00');
    });

    it('round-trips through JSON', () => {
      const original = Money.from({ amount: '123.45', currency: 'BRL' });
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });
  });
});
