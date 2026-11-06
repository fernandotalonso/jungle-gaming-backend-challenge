import { generateId } from '../../../shared/ids';
import { toDate } from '../../../shared/domain/coerce';
import type { DateLike } from '../../../shared/domain/date-like';
import { DomainError, InvalidAmountError, InvalidLedgerEntryError } from '../../../shared/domain/errors';
import { LedgerDirection } from '../../../shared/domain/ledger-direction';
import { Money, type MoneyProps } from '../../../shared/domain/money';

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection | string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: DateLike;
}

/**
 * Immutable ledger entry. There are no mutable fields and no transition
 * methods — immutability is structural (frozen instance, read-only API), not
 * a convention. `create` validates the arithmetic of the entry.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { walletId, transactionId, direction, money, balanceBefore, balanceAfter } = props;

    assertNonEmpty(walletId, 'walletId');
    assertNonEmpty(transactionId, 'transactionId');
    if (!money.isPositive()) {
      throw new InvalidAmountError(`ledger entry amount must be positive, got ${money.toString()}`);
    }

    const expectedAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);

    if (!expectedAfter.equals(balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `unbalanced entry: ${balanceBefore.toString()} ${direction === LedgerDirection.Credit ? '+' : '-'} ${money.toString()} !== ${balanceAfter.toString()} (expected ${expectedAfter.toString()})`,
      );
    }

    return new WalletLedgerEntry(
      generateId(),
      walletId,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      props.createdAt ?? new Date(),
    );
  }

  /** Reconstruction from persistence — does not revalidate invariants. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    const direction = state.direction as LedgerDirection;
    if (direction !== LedgerDirection.Debit && direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError(`invalid ledger direction: ${String(state.direction)}`);
    }
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      toDate(state.createdAt),
    );
  }

  /** balanceBefore ± money === balanceAfter. Checked at creation; kept as a query. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(`${label} must be a non-empty string`);
  }
}
