# Deduplicate accepted Orders by submission key; do not store rejections

Supersedes [ADR 0002](0002-replay-submission-outcomes.md).

The challenge asks for verification without submission and for submission that accepts an order against current stock. It does not require replaying every outcome. A double click or a retry after a lost response must still not create a second Order or consume stock twice. To get that protection at the lowest cost, `POST /orders` takes a required client-generated `submissionId`. It is stored as the unique `submission_key` on the accepted Order row. There are no separate submission, rejection, or outcome tables.

Inside the submission transaction, after the warehouse rows are locked:

- If an Order with that key exists and has the same quantity and Destination, return it without recalculating or deducting stock.
- If an Order with that key exists and has different inputs, report a conflict and leave the Order unchanged.
- Otherwise evaluate the request against current inventory. On acceptance, save the Order and its allocations and deduct stock together. The unique index is the backstop.

Consequences:

- Business rejections (insufficient stock or shipping over the limit) are returned and not stored. A rejected request consumes no key. Repeating it reevaluates against current inventory and may succeed.
- Malformed requests and failed transactions consume no key either.
- Keys are retained as long as their Orders. No expiry is needed for this challenge.
- The schema has no lookup tables. ADR 0003's references to submissions and lookup tables apply only if such tables are reintroduced.
