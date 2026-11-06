import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../../src/modules/wallets/domain/wallet';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  DomainError,
} from '../../../src/shared/domain/errors';
import { LedgerDirection } from '../../../src/shared/domain/ledger-direction';
import { Money } from '../../../src/shared/domain/money';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const TX = 'tx-1';

function openWallet(initialBalance = '100.00'): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
  });
}

describe('Wallet.open', () => {
  it('starts at version 1 with the given balance and derived currency', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toBeInstanceOf(Date);
  });

  it('allows opening with zero balance (OPENING transaction is optional)', () => {
    const wallet = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('rejects empty id or playerId', () => {
    expect(() =>
      Wallet.open({ id: '', playerId: 'p1', initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }) }),
    ).toThrow(DomainError);
    expect(() =>
      Wallet.open({ id: 'w1', playerId: '', initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }) }),
    ).toThrow(DomainError);
  });
});

describe('Wallet.credit', () => {
  it('adds to balance, bumps version and returns a CREDIT entry', () => {
    const wallet = openWallet();
    const at = new Date('2026-01-01T12:00:00Z');
    const entry = wallet.credit(TX, Money.from({ amount: '50.00', currency: 'BRL' }), at);

    expect(wallet.balance.toString()).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(at);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('150.00');
    expect(entry.money.toString()).toBe('50.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects amounts of a different currency', () => {
    const wallet = openWallet();
    expect(() => wallet.credit(TX, Money.from({ amount: '50.00', currency: 'USD' }))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('rejects zero and negative amounts', () => {
    const wallet = openWallet();
    expect(() => wallet.credit(TX, Money.zero('BRL'))).toThrow(InvalidAmountError);
    expect(() => wallet.credit(TX, Money.from({ amount: '-1.00', currency: 'BRL' }))).toThrow(InvalidAmountError);
  });
});

describe('Wallet.debit', () => {
  it('subtracts from balance, bumps version and returns a DEBIT entry', () => {
    const wallet = openWallet();
    const entry = wallet.debit(TX, Money.from({ amount: '80.00', currency: 'BRL' }));

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows debiting the exact balance down to zero', () => {
    const wallet = openWallet();
    wallet.debit(TX, Money.from({ amount: '100.00', currency: 'BRL' }));
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.balance.isNegative()).toBe(false);
  });

  it('rejects when the balance could not cover the amount', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(TX, Money.from({ amount: '100.01', currency: 'BRL' }))).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects wrong currency and non-positive amounts', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(TX, Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(TX, Money.zero('BRL'))).toThrow(InvalidAmountError);
    expect(() => wallet.debit('', Money.from({ amount: '1.00', currency: 'BRL' }))).toThrow(DomainError);
  });
});

describe('Wallet version semantics', () => {
  it('increments only when the balance changes', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    wallet.debit('tx-a', Money.from({ amount: '10.00', currency: 'BRL' }));
    expect(wallet.version).toBe(2);
    wallet.credit('tx-b', Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(wallet.version).toBe(3);
    // failed debit does not change version
    expect(() => wallet.debit('tx-c', Money.from({ amount: '999.00', currency: 'BRL' }))).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.version).toBe(3);
  });
});

describe('Wallet.rehydrate', () => {
  it('reconstructs state without revalidating domain rules', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: 'player-1',
      currency: 'BRL',
      balance: { amount: '42.00', currency: 'BRL' },
      version: 42,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-11-06T10:30:00.000Z',
    });

    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(42);
    expect(wallet.updatedAt.toISOString()).toBe('2026-11-06T10:30:00.000Z');
    expect(wallet.createdAt.toISOString()).toBe('2026-01-01T10:00:00.000Z');
  });

  it('rejects invalid persisted dates', () => {
    expect(() =>
      Wallet.rehydrate({
        id: WALLET_ID,
        playerId: 'player-1',
        currency: 'BRL',
        balance: { amount: '42.00', currency: 'BRL' },
        version: 1,
        createdAt: 'not-a-date',
        updatedAt: new Date(),
      }),
    ).toThrow(DomainError);
  });

  it('keeps operating after rehydration', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: 'player-1',
      currency: 'BRL',
      balance: { amount: '42.00', currency: 'BRL' },
      version: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    wallet.debit(TX, Money.from({ amount: '2.00', currency: 'BRL' }));
    expect(wallet.balance.toString()).toBe('40.00');
    expect(wallet.version).toBe(8);
  });
});
