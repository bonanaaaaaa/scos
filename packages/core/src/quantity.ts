import { MONEY_MAX } from "./money";
import { UNIT_PRICE } from "./product";
import { type Result, type ValidationError, err, ok, validationError } from "./result";

declare const quantityBrand: unique symbol;

/** A validated, positive integer number of units. */
export type Quantity = number & { readonly [quantityBrand]: true };

/**
 * Largest quantity whose merchandise subtotal (quantity x $150) fits
 * NUMERIC(12, 2): floor(9999999999.99 / 150) = 66,666,666.
 *
 * This is a storage-representability bound derived from the constants, not a
 * business cap. Every quantity at or below it yields merchandise amounts that
 * fit NUMERIC(12, 2); valid orders are further bounded by available stock.
 * Inbound adapters apply the same limit as a malformed-input (HTTP 400) check.
 */
export const MAX_QUANTITY: number = MONEY_MAX.dividedToIntegerBy(UNIT_PRICE).toNumber();

export function parseQuantity(value: unknown): Result<Quantity, ValidationError> {
  if (typeof value !== "number") {
    return err(validationError("quantity", "NOT_A_NUMBER", "Quantity must be a number."));
  }
  if (!Number.isFinite(value)) {
    return err(validationError("quantity", "NOT_FINITE", "Quantity must be finite."));
  }
  if (!Number.isInteger(value)) {
    return err(validationError("quantity", "NOT_INTEGER", "Quantity must be an integer."));
  }
  if (value <= 0) {
    return err(validationError("quantity", "NOT_POSITIVE", "Quantity must be at least 1."));
  }
  if (value > MAX_QUANTITY) {
    return err(
      validationError("quantity", "OUT_OF_RANGE", `Quantity must be at most ${MAX_QUANTITY}.`),
    );
  }
  return ok(value as Quantity);
}
