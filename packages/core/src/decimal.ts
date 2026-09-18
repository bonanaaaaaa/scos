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
 * needs at most 28 significant digits. Sums of contributions of magnitude up to
 * ~1e10 keep sub-cent digits far below the cent rounding point, so rounding at
 * 40 digits never changes a cent result.
 */
export const DomainDecimal: Decimal.Constructor = Decimal.clone({
  defaults: true,
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type { Decimal };
