import { type Decimal, DomainDecimal } from "./decimal";
import { DomainError } from "./errors";

/** Largest value representable by PostgreSQL NUMERIC(12, 2). */
export const MONEY_MAX_STRING = "9999999999.99";
export const MONEY_MAX: Decimal = new DomainDecimal(MONEY_MAX_STRING);
export const MONEY_SCALE = 2;

const PLAIN_DECIMAL = /^\d{1,10}(?:\.\d{1,2})?$/;

/**
 * A non-negative USD amount at cent scale that fits NUMERIC(12, 2).
 *
 * Construction fails with a DomainError rather than rounding or truncating, so
 * an amount that cannot be stored exactly never reaches persistence.
 * Intermediate, unrounded values (such as individual shipping contributions or
 * the 15% shipping limit) stay as decimals inside pricing functions.
 */
export class Money {
  readonly #amount: Decimal;

  private constructor(amount: Decimal) {
    this.#amount = amount;
    Object.freeze(this);
  }

  static fromDecimal(amount: Decimal): Money {
    if (!amount.isFinite() || amount.lessThan(0)) {
      throw new DomainError(
        "INVALID_AMOUNT",
        `Money must be a finite, non-negative amount; received ${amount.toString()}.`,
      );
    }
    if (amount.decimalPlaces() > MONEY_SCALE) {
      throw new DomainError(
        "INVALID_AMOUNT",
        `Money must be at cent scale; received ${amount.toString()}.`,
      );
    }
    if (amount.greaterThan(MONEY_MAX)) {
      throw new DomainError(
        "AMOUNT_OUT_OF_RANGE",
        `Money ${amount.toFixed(MONEY_SCALE)} exceeds NUMERIC(12, 2) maximum ${MONEY_MAX_STRING}.`,
      );
    }
    // Normalise negative zero and carry the value in the domain configuration.
    return new Money(new DomainDecimal(amount.abs()));
  }

  /**
   * Parses a plain decimal string such as "150.00" (for example, a stored
   * amount): 1-10 integer digits and at most two fractional digits, matching
   * NUMERIC(12, 2). Signs, exponents, hex/binary/octal prefixes, separators,
   * and whitespace are rejected.
   */
  static parse(value: string): Money {
    if (!PLAIN_DECIMAL.test(value)) {
      throw new DomainError("INVALID_AMOUNT", `Money is not a plain decimal string: ${value}.`);
    }
    return Money.fromDecimal(new DomainDecimal(value));
  }

  /** Rounds an exact amount once to cents using ROUND_HALF_UP. */
  static roundToCents(amount: Decimal): Money {
    return Money.fromDecimal(amount.toDecimalPlaces(MONEY_SCALE, DomainDecimal.ROUND_HALF_UP));
  }

  toDecimal(): Decimal {
    return this.#amount;
  }

  plus(other: Money): Money {
    return Money.fromDecimal(this.#amount.plus(other.#amount));
  }

  minus(other: Money): Money {
    return Money.fromDecimal(this.#amount.minus(other.#amount));
  }

  equals(other: Money): boolean {
    return this.#amount.equals(other.#amount);
  }

  /** Decimal string with exactly two fractional digits, e.g. "150.00". */
  toString(): string {
    return this.#amount.toFixed(MONEY_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}
