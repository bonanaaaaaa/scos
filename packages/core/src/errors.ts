export type DomainErrorCode =
  | "INVALID_AMOUNT"
  | "AMOUNT_OUT_OF_RANGE"
  | "INVALID_INVENTORY"
  | "INVALID_ORDER";

/**
 * Thrown when a domain invariant would be violated. These indicate programming
 * or data errors (for example corrupt inventory or an amount that cannot be
 * stored), not malformed client input, which is reported through `Result`.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
