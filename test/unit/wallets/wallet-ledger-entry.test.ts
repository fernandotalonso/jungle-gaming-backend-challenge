import { describe, expect, it } from 'bun:test';
import { WalletLedgerEntry } from '../../../src/modules/wallets/domain/wallet-ledger-entry';
import { CurrencyMismatchError, InvalidAmountError, InvalidLedgerEntryError } from '../../../src/shared/domain/errors';
import { LedgerDirection } from '../../../src/shared/domain/ledger-direction';
import { Money } from '../../../src/shared/domain/money';

function build(direction: LedgerDirection, before = '100.00', amount = '40.00', after = '60.00') {
  return WalletLedgerEntry.create({
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction,
    money: Money.from({ amount, currency: 'BRL' }),
    balanceBefore: Money.from({ amount: before, currency: 'BRL' }),
    balanceAfter: Money.from({ amount: after, currency: 'BRL' }),
  });
}

describe('WalletLedgerEntry.create', () => {
  it('creates a balanced DEBIT entry', () => {
    const entry = build(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates a balanced CREDIT entry', () => {
    const entry = WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '60.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects unbalanced arithmetic', () => {
    // 100 - 40 should be 60, not 50
    expect(() => build(LedgerDirection.Debit, '100.00', '40.00', '50.00')).toThrow(InvalidLedgerEntryError);
    // 100 + 40 should be 140, not 100
    expect(() => build(LedgerDirection.Credit, '100.00', '40.00', '100.00')).toThrow(InvalidLedgerEntryError);
  });

  it('rejects non-positive amounts', () => {
    expect(() => build(LedgerDirection.Debit, '100.00', '0.00', '100.00')).toThrow(InvalidAmountError);
    expect(() => build(LedgerDirection.Debit, '100.00', '-40.00', '140.00')).toThrow(InvalidAmountError);
  });

  it('rejects currency mismatch across entry fields', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '40.00', currency: 'USD' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '60.00', currency: 'BRL' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('reconstructs from persistence state', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: '0192f2a0-0000-7000-8000-000000000001',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: { amount: '40.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '60.00', currency: 'BRL' },
      createdAt: '2026-11-06T10:00:00.000Z',
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.createdAt.toISOString()).toBe('2026-11-06T10:00:00.000Z');
  });

  it('rejects invalid direction values', () => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        id: 'x',
        walletId: 'w',
        transactionId: 't',
        direction: 'UP',
        money: { amount: '1.00', currency: 'BRL' },
        balanceBefore: { amount: '1.00', currency: 'BRL' },
        balanceAfter: { amount: '1.00', currency: 'BRL' },
        createdAt: new Date(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe('immutability', () => {
  it('instances are frozen and expose no mutators', () => {
    const entry = build(LedgerDirection.Debit);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as Record<string, unknown>).money = Money.zero('BRL');
    }).toThrow(TypeError);
    expect(entry.money.toString()).toBe('40.00');
  });
});
