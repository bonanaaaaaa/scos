# @scos/core

Pure SCOS domain layer: value objects, pricing, distance, warehouse allocation,
Order Estimates, and the Order aggregate. No HTTP, Prisma, or persistence types.

## Layout

Hexagonal layering; adapters import only the package root (`src/index.ts`).

- `src/domain/`: value objects, pricing, distance, allocation, estimates and the
  Order aggregate. Pure, with no I/O and no ports.
- `src/application/` (added with the use cases): VerifyOrder / SubmitOrder and
  the driven ports that persistence implements.

Dependencies point inward: `domain/` must not import `application/`. The
`.oxlintrc.json` in this package enforces that with `no-restricted-imports`.

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

## Error handling

Core separates three kinds of failure, and each has one mechanism:

| Failure                                   | Mechanism                                                | Examples                                                               |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Malformed input (expected)                | Zod schema `.safeParse` result (`success` / `error`)     | `quantitySchema`, `destinationSchema`, `orderRequestSchema`            |
| Business rejection of a well-formed order | A typed estimate outcome: `valid: false` with a `reason` | `INSUFFICIENT_STOCK`, `SHIPPING_EXCEEDS_LIMIT` from `estimateOrder`    |
| Violated domain invariant or bug          | `throw new DomainError(code, message)`                   | corrupt inventory, inconsistent order, amount outside `NUMERIC(12, 2)` |

- **Validation returns a result, not exceptions.** Core's input guards are Zod
  schemas; callers use `.safeParse` and handle `success: false` as an expected
  outcome instead of catching `ZodError`. Object schemas report every field
  issue (with its `path`) instead of stopping at the first, so an adapter can
  answer with a single HTTP 400 that lists all problems. Successful parses
  return the branded `Quantity` / `Destination` / `OrderRequest` values that
  `estimateOrder` requires.
- **Business rejections are data.** Verification must still report the
  merchandise and discount amounts for a rejected order, so the estimate carries
  `valid`, `reason`, and the amounts; nothing is thrown.
- **`DomainError` means something is wrong on our side.** Core throws it only
  when an invariant is broken (data or programming error), even where the check
  reuses a Zod schema (for example inventory coordinates or an unvalidated
  request passed to `estimateOrder`); a `ZodError` never escapes core.

Core depends on Zod but not on Hono. The inbound API adapter keeps its own HTTP
request schemas through `@hono/standard-validator` (see
[design decisions](../../docs/design-decisions.md)); their limits must match
core's (`MAX_QUANTITY`, `LATITUDE_LIMIT`, `LONGITUDE_LIMIT`). The adapter then
converts the body with `orderRequestSchema`, which acts as the domain's own
guard and should not fail for input the HTTP schema accepted.

Inbound adapters (#9–#11) must follow this mapping:

- HTTP schema failures and core schema `safeParse` failures -> HTTP 400 listing
  every problem;
- business outcomes -> their documented status (verification 200 with
  `valid: false`; submission 422);
- `DomainError` (and any other thrown error) -> HTTP 500, without leaking
  internal details.

## Supported input bounds

Enforced by the exported Zod schemas:

- **Quantity (`quantitySchema`):** a positive safe integer no greater than
  `MAX_QUANTITY` (66,666,666 = floor(9999999999.99 / 150), derived from the
  constants). NaN, ±Infinity, fractions, `0`, `-0` and non-numbers are
  rejected. This is a storage-representability bound, not a business cap: any
  quantity within it gives merchandise amounts that fit `NUMERIC(12, 2)`, and
  valid orders are further bounded by available stock. Inbound adapters should
  reject larger values as malformed input (HTTP 400) using the exported
  constant.
- **Destination (`destinationSchema`):** finite latitude in `[-90, 90]` and
  longitude in `[-180, 180]`, inclusive. Supplied precision (including `-0`) is
  preserved, unknown keys are stripped, and the parsed value is frozen.
- **Order request (`orderRequestSchema`):** `{ quantity, latitude, longitude }`
  with the rules above, parsed to a frozen `{ quantity, destination }`.

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
