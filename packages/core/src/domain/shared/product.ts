/**
 * Domain constants: SCOS Station P1 Pro.
 *
 * Commercial facts about the single product, constructed from decimal
 * strings. Not an entity: there is one product, so it needs no identity.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { type Decimal, DomainDecimal } from "./decimal";

export const UNIT_PRICE: Decimal = new DomainDecimal("150");
export const UNIT_WEIGHT_KG: Decimal = new DomainDecimal("0.365");
export const SHIPPING_RATE_PER_KG_KM: Decimal = new DomainDecimal("0.01");
/** Rounded shipping must not exceed this share of the discounted merchandise total. */
export const SHIPPING_LIMIT_RATIO: Decimal = new DomainDecimal("0.15");
