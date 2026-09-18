import { parseDestination } from "./destination.js";
import type { OrderRequest } from "./estimate.js";
import { parseQuantity } from "./quantity.js";
import { type Result, type ValidationError, err, ok } from "./result.js";

export interface OrderRequestInput {
  readonly quantity: unknown;
  readonly latitude: unknown;
  readonly longitude: unknown;
}

/** Validates raw request fields, reporting every malformed field at once. */
export function parseOrderRequest(
  input: OrderRequestInput,
): Result<OrderRequest, readonly ValidationError[]> {
  const quantity = parseQuantity(input.quantity);
  const destination = parseDestination(input.latitude, input.longitude);
  if (quantity.ok && destination.ok) {
    return ok(Object.freeze({ quantity: quantity.value, destination: destination.value }));
  }
  const errors: ValidationError[] = [];
  if (!quantity.ok) errors.push(quantity.error);
  if (!destination.ok) errors.push(...destination.error);
  return err(Object.freeze(errors));
}
