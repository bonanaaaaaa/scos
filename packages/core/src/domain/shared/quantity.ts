/**
 * Value object: Quantity.
 *
 * A number of units with no identity, equal by value. It is branded: holding a
 * `Quantity` proves the value was validated.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { z } from "zod";

import { MONEY_MAX } from "#domain/shared/money";
import { UNIT_PRICE } from "#domain/shared/product";

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

/**
 * Domain input guard for a quantity: a positive safe integer no greater than
 * MAX_QUANTITY. Rejects NaN, ±Infinity, fractions, 0, -0 and non-numbers.
 * Callers use `.safeParse` (see "Error handling" in packages/core/README.md).
 */
export const quantitySchema = z.number().int().positive().max(MAX_QUANTITY).brand<"Quantity">();

/** A validated, positive integer number of units. */
export type Quantity = z.infer<typeof quantitySchema>;
