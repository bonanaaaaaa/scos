export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return Object.freeze({ ok: true, value });
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return Object.freeze({ ok: false, error });
}

export type ValidationField = "quantity" | "latitude" | "longitude";

export type ValidationErrorCode =
  | "NOT_A_NUMBER"
  | "NOT_FINITE"
  | "NOT_INTEGER"
  | "NOT_POSITIVE"
  | "OUT_OF_RANGE";

/** A malformed-input error; inbound adapters map these to HTTP 400. */
export interface ValidationError {
  readonly field: ValidationField;
  readonly code: ValidationErrorCode;
  readonly message: string;
}

export function validationError(
  field: ValidationField,
  code: ValidationErrorCode,
  message: string,
): ValidationError {
  return Object.freeze({ field, code, message });
}
