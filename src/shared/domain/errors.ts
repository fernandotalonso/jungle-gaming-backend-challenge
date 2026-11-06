/**
 * Base class for all domain errors. Throwing a DomainError is a programming
 * or validation error inside the domain layer — business rejections are
 * modeled as transaction state transitions (REJECTED + FailureCode), not
 * exceptions.
 */
export class DomainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MoneyValidationError extends DomainError {}
export class CurrencyMismatchError extends DomainError {}
export class InvalidAmountError extends DomainError {}
export class InsufficientFundsError extends DomainError {}
export class InvalidWalletStateError extends DomainError {}
export class InvalidLedgerEntryError extends DomainError {}
export class InvalidTransactionError extends DomainError {}
export class InvalidTransactionStateError extends DomainError {}
export class InvalidReferenceError extends DomainError {}
export class InvalidMessageStateError extends DomainError {}
