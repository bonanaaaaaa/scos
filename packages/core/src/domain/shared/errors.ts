/**
 * Domain exception: DomainError.
 *
 * Signals a broken invariant (a data or programming error on our side), not
 * bad input or a business rejection.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

export type DomainErrorCode =
  | "INVALID_AMOUNT"
  | "AMOUNT_OUT_OF_RANGE"
  | "INVALID_INVENTORY"
  | "INVALID_REQUEST"
  | "INVALID_ORDER";

/**
 * Thrown only when a domain invariant would be violated. These indicate
 * programming or data errors (for example corrupt inventory or an amount that
 * cannot be stored) and map to a server error (HTTP 500). Malformed client
 * input is not thrown: it is reported by the Zod schemas' `safeParse` results.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
