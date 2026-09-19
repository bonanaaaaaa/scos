/**
 * Technical utility: decimal arithmetic configuration.
 *
 * Not a DDD building block: it is the arithmetic configuration that the value
 * objects and domain services rely on for exact monetary calculation.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { Decimal } from "decimal.js";

/**
 * Isolated decimal.js constructor for all SCOS domain arithmetic.
 *
 * Why precision 40: the widest supported intermediate needs at most 28
 * significant digits, so 40 keeps every shipping contribution exact with a
 * 12-digit margin while staying cheap. The decimal.js default of 20 is too
 * small: it rounds contributions, which can move the final cent (for example
 * 25833059 units x 0.00365 x 0.23527254705070336 km is exactly
 * 22184.004999999999999880576, i.e. $22,184.00, but 20 digits give 22184.005,
 * which rounds to $22,184.01).
 *
 * Bound: a contribution is quantity (at most 8 digits, see MAX_QUANTITY) x the
 * 0.00365 per-km rate (3 digits) x a distance converted from a JavaScript
 * number (at most 17 digits), so at most 8 + 3 + 17 = 28 digits. A sum of
 * contributions whose magnitudes differ widely can exceed 40 digits; the excess
 * is rounded at the 40th significant digit, which for sums below 1e10 sits at
 * or below 1e-30. That could change the final cent only if the exact sum lay
 * within ~1e-30 of a half-cent boundary: practically never, but not a
 * mathematical guarantee.
 *
 * The global `Decimal` is never configured or mutated. `defaults: true` resets
 * every unspecified setting to the library defaults so this configuration does
 * not inherit changes another module may have made to the global constructor.
 */
export const DomainDecimal: Decimal.Constructor = Decimal.clone({
  defaults: true,
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type { Decimal };
