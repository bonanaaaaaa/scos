import { Decimal } from "decimal.js";
import { describe, expect, test } from "vitest";

import { DomainDecimal } from "./decimal.js";
import { DomainError } from "./errors.js";
import { MONEY_MAX_STRING, Money } from "./money.js";

describe("DomainDecimal", () => {
  test("uses an isolated 40-digit HALF_UP configuration without mutating the global Decimal", () => {
    expect(DomainDecimal.precision).toBe(40);
    expect(DomainDecimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(DomainDecimal).not.toBe(Decimal);
    expect(Decimal.precision).toBe(20);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
  });
});

describe("Money", () => {
  test("formats as a two-decimal string", () => {
    expect(Money.parse("150").toString()).toBe("150.00");
    expect(Money.parse("0.5").toJSON()).toBe("0.50");
    expect(JSON.stringify({ amount: Money.parse("7.5") })).toBe('{"amount":"7.50"}');
  });

  test("rounds once to cents using HALF_UP", () => {
    expect(Money.roundToCents(new DomainDecimal("0.005")).toString()).toBe("0.01");
    expect(Money.roundToCents(new DomainDecimal("0.00499999")).toString()).toBe("0.00");
    expect(Money.roundToCents(new DomainDecimal("2.675")).toString()).toBe("2.68");
  });

  test("accepts the NUMERIC(12, 2) maximum and rejects anything larger", () => {
    expect(Money.parse(MONEY_MAX_STRING).toString()).toBe("9999999999.99");
    expect(() => Money.parse("10000000000.00")).toThrow(DomainError);
    try {
      Money.parse("9999999999.99").plus(Money.parse("0.01"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("AMOUNT_OUT_OF_RANGE");
    }
    expect(() => Money.roundToCents(new DomainDecimal("9999999999.995"))).toThrow(
      /exceeds NUMERIC/,
    );
  });

  test("rejects sub-cent, negative, non-finite, and non-numeric amounts", () => {
    expect(() => Money.parse("0.001")).toThrow(/cent scale/);
    expect(() => Money.parse("-0.01")).toThrow(/non-negative/);
    expect(() => Money.parse("Infinity")).toThrow(/finite/);
    expect(() => Money.parse("NaN")).toThrow(/finite/);
    expect(() => Money.parse("abc")).toThrow(/decimal string/);
    expect(() => Money.parse("1").minus(Money.parse("2"))).toThrow(DomainError);
  });

  test("normalises negative zero and compares by value", () => {
    expect(Money.fromDecimal(new DomainDecimal("-0")).toString()).toBe("0.00");
    expect(Money.parse("1.10").equals(Money.parse("1.1"))).toBe(true);
    expect(Money.parse("3").minus(Money.parse("1.25")).toString()).toBe("1.75");
  });

  test("is immutable", () => {
    expect(Object.isFrozen(Money.parse("1"))).toBe(true);
  });
});
