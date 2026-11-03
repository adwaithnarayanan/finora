export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCurrencyError extends MoneyError {}

export class InvalidAmountError extends MoneyError {}

export class PrecisionError extends MoneyError {}

export class CurrencyMismatchError extends MoneyError {}

export class InvalidAllocationError extends MoneyError {}
