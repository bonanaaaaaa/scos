# @scos/core

Pure SCOS domain layer: value objects, pricing, distance, warehouse allocation,
Order Estimates, and the Order aggregate. No HTTP, Prisma, or persistence types.

## Numeric policy

- **Decimal arithmetic:** an isolated `decimal.js` clone (`defaults: true`,
  40 significant digits, `ROUND_HALF_UP`). The global `Decimal` is never
  configured. All commercial constants are built from strings: unit price
  `"150"`, unit weight `"0.365"` kg, rate `"0.01"` $/kg/km, limit ratio `"0.15"`,
  discount rates `"0.05"`-`"0.20"`.
- **Money:** non-negative, exactly two decimal places, at most
  `9999999999.99` (PostgreSQL `NUMERIC(12, 2)`). Constructing a `Money` outside
  that range throws `DomainError` (`AMOUNT_OUT_OF_RANGE` / `INVALID_AMOUNT`)
  instead of rounding, so an unrepresentable amount cannot reach persistence.
  Amounts serialise as decimal strings such as `"150.00"`.
- **Discounts** are exact at cents for every quantity; only the combined
  shipping charge is rounded, once, to cents half-up. Rounded shipping is
  compared to the exact 15% of the discounted merchandise total; equality passes.
- **Distance:** Haversine with JavaScript `number`, Earth radius
  `EARTH_RADIUS_KM = 6371.0088` (IUGG mean radius), unrounded coordinates, the
  intermediate clamped to `[0, 1]`, and unrounded kilometres converted to decimal
  through `String(distanceKm)`.

## Supported input bounds

- **Quantity:** a positive integer no greater than `MAX_QUANTITY` (66,666,666 =
  floor(9999999999.99 / 150), derived from the constants). This is a
  storage-representability bound, not a business cap: any quantity within it
  gives merchandise amounts that fit `NUMERIC(12, 2)`, and valid orders are
  further bounded by available stock. Inbound adapters should reject larger
  values as malformed input (HTTP 400) using the exported constant.
- **Destination:** finite latitude in `[-90, 90]` and longitude in
  `[-180, 180]`, inclusive.
- Shipping and order totals for quantities within `MAX_QUANTITY` could only
  overflow `NUMERIC(12, 2)` with tens of millions of units in stock; if that
  ever happens `estimateOrder` throws `DomainError` `AMOUNT_OUT_OF_RANGE` rather
  than returning an unstorable amount.

Input validation (`parseQuantity`, `parseDestination`, `parseOrderRequest`)
returns a `Result` with typed `ValidationError`s. Domain invariant violations
(corrupt inventory, invalid orders, unrepresentable money) throw `DomainError`.
