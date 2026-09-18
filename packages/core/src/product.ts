import { type Decimal, DomainDecimal } from "./decimal.js";

// SCOS Station P1 Pro commercial constants, constructed from decimal strings.
export const UNIT_PRICE: Decimal = new DomainDecimal("150");
export const UNIT_WEIGHT_KG: Decimal = new DomainDecimal("0.365");
export const SHIPPING_RATE_PER_KG_KM: Decimal = new DomainDecimal("0.01");
/** Rounded shipping must not exceed this share of the discounted merchandise total. */
export const SHIPPING_LIMIT_RATIO: Decimal = new DomainDecimal("0.15");
