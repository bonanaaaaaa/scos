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

Input validation (`parseQuantity`, `parseDestination`, `parseOrderRequest`)
returns a `Result` with typed `ValidationError`s. Domain invariant violations
(corrupt inventory, invalid orders, unrepresentable money) throw `DomainError`.

### Overflow behaviour of `estimateOrder`

- **Valid estimates cannot overflow.** Below 250 units every amount is under
  $37,500. From 250 units the discounted total is at most 120 x 66,666,666 =
  7,999,999,920.00. Shipping on a valid estimate is at most 15% of that, so the
  order total is at most 9,199,999,908.00, which is below 9,999,999,999.99.
- **Insufficient-stock estimates cannot overflow.** They carry merchandise
  amounts only, which `MAX_QUANTITY` bounds.
- **Only a shipping-exceeds-limit estimate can throw.** Shipping and the order
  total are computed before the limit check, and `Money` refuses amounts
  above NUMERIC(12, 2). The worst per-unit shipping charge is
  0.00365 x pi x 6371.0088 km, about $73.06. Shipping alone therefore cannot
  exceed the maximum within `MAX_QUANTITY`, but the order total
  (at most about $193.06 per unit) can. That needs roughly 51.8 million units in
  stock, allocated at near-antipodal distance. In that case `estimateOrder`
  throws `DomainError` with code `AMOUNT_OUT_OF_RANGE` instead of returning a
  rejection. Adapters should treat it as an unexpected server error, not as
  client input.
