import { toDate } from '../../../shared/domain/coerce';
import type { DateLike } from '../../../shared/domain/date-like';
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidWalletStateError,
} from '../../../shared/domain/errors';
import { LedgerDirection } from '../../../shared/domain/ledger-direction';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: DateLike;
  updatedAt: DateLike;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

/**
 * Wallet aggregate root. Owns the balance and guarantees that every movement
 * produces the matching immutable ledger entry, so balance and ledger can
 * never drift apart within the aggregate boundary.
 *
 * Invariants:
 * - balance is never negative;
 * - every balance change bumps `version`;
 * - currency is fixed at creation (derived from the initial balance);
 * - concurrent access is governed by the persistence layer (row lock /
 *   conditional update) — this class is not thread-safe by itself.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    const { id, playerId, initialBalance, now } = props;

    if (typeof id !== 'string' || id.length === 0) {
      throw new DomainError('wallet id must be a non-empty string');
    }
    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw new DomainError('playerId must be a non-empty string');
    }

    const timestamp = now ?? new Date();
    return new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, timestamp, timestamp);
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      toDate(state.createdAt),
      toDate(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Ledger entry for the creation itself: balanceBefore 0 -> balanceAfter
   * initial balance. Creation is a single state transition — version stays 1
   * and the aggregate is not mutated. Only valid on a freshly opened wallet.
   */
  openingEntry(transactionId: string): WalletLedgerEntry {
    if (this._version !== 1) {
      throw new InvalidWalletStateError(`openingEntry is only valid on a newly opened wallet (version ${this._version})`);
    }
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  /** Applies a debit and returns the matching immutable ledger entry. */
  debit(transactionId: string, amount: Money, at?: Date): WalletLedgerEntry {
    this.assertCanMove(transactionId, amount);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(amount);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(
        `wallet ${this.id}: insufficient funds (balance ${balanceBefore.toString()}, required ${amount.toString()})`,
      );
    }

    this.commitMovement(balanceAfter, at);
    return this.buildEntry(transactionId, LedgerDirection.Debit, amount, balanceBefore, balanceAfter);
  }

  /** Applies a credit and returns the matching immutable ledger entry. */
  credit(transactionId: string, amount: Money, at?: Date): WalletLedgerEntry {
    this.assertCanMove(transactionId, amount);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(amount);

    this.commitMovement(balanceAfter, at);
    return this.buildEntry(transactionId, LedgerDirection.Credit, amount, balanceBefore, balanceAfter);
  }

  private assertCanMove(transactionId: string, amount: Money): void {
    if (typeof transactionId !== 'string' || transactionId.length === 0) {
      throw new DomainError('transactionId must be a non-empty string');
    }
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet ${this.id} currency ${this.currency} !== movement currency ${amount.currency}`,
      );
    }
    if (!amount.isPositive()) {
      throw new InvalidAmountError(`wallet movement must be positive, got ${amount.toString()}`);
    }
  }

  private commitMovement(balanceAfter: Money, at?: Date): void {
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at ?? new Date();
  }

  private buildEntry(
    transactionId: string,
    direction: LedgerDirection,
    amount: Money,
    balanceBefore: Money,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    // WalletLedgerEntry.create re-validates the arithmetic — belt and braces.
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: this._updatedAt,
    });
  }
}
