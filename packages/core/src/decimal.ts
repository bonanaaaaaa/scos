import { Decimal } from "decimal.js";

/**
 * Isolated decimal.js constructor for all SCOS domain arithmetic.
 *
 * The global `Decimal` is never configured or mutated. `defaults: true` resets
 * every unspecified setting to the library defaults so this configuration does
 * not inherit changes another module may have made to the global constructor.
 *
 * Precision is 40 significant digits. The widest supported intermediate value
 * is a shipping contribution: quantity (at most 8 digits, see MAX_QUANTITY)
 * times the 0.00365 per-km rate (3 significant digits) times a distance
 * converted from a JavaScript number (at most 17 significant digits), which
 * needs at most 28 significant digits, so each contribution is exact. A sum
 * of contributions can need more digits than 40 when their magnitudes differ
 * widely; the excess is then rounded away at the 40th significant digit. For
 * sums below 1e10 that digit sits at or below 1e-30, so the only way it could
 * change the final cent is if the exact sum lay within ~1e-30 of a half-cent
 * boundary. That is practically never, but it is not a mathematical guarantee.
 */
export const DomainDecimal: Decimal.Constructor = Decimal.clone({
  defaults: true,
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type { Decimal };
