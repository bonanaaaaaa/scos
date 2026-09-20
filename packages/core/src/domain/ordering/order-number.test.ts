import { describe, expect, test } from "vitest";

import { ORDER_NUMBER_PATTERN, generateOrderNumber } from "#domain/ordering/order-number";

describe("generateOrderNumber", () => {
  test("generates SO- followed by 12 Crockford base32 characters", () => {
    for (let index = 0; index < 1000; index += 1) {
      const orderNumber = generateOrderNumber();
      expect(orderNumber).toMatch(ORDER_NUMBER_PATTERN);
      expect(orderNumber.slice(3)).not.toMatch(/[ILOU]/);
    }
  });

  test("generates distinct numbers", () => {
    const numbers = new Set(Array.from({ length: 1000 }, () => generateOrderNumber()));
    expect(numbers.size).toBe(1000);
  });

  test("uses every Crockford character and nothing else", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      for (const character of generateOrderNumber().slice(3)) seen.add(character);
    }
    expect([...seen].sort().join("")).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  });
});

describe("ORDER_NUMBER_PATTERN", () => {
  test.each(["SO-0123456789AB", "SO-ZZZZZZZZZZZZ", "SO-000000000000"])("accepts %s", (value) => {
    expect(ORDER_NUMBER_PATTERN.test(value)).toBe(true);
  });

  test.each([
    "",
    "SO-",
    "SO-0123456789A",
    "SO-0123456789ABC",
    "so-0123456789AB",
    "SO-0123456789ab",
    "SO-0123456789AI",
    "SO-0123456789AL",
    "SO-0123456789AO",
    "SO-0123456789AU",
    " SO-0123456789AB",
    "SO-0123456789AB\n",
    "XX-0123456789AB",
  ])("rejects %j", (value) => {
    expect(ORDER_NUMBER_PATTERN.test(value)).toBe(false);
  });
});
