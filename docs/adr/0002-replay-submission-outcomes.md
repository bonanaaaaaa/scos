# Replay successful submissions and business rejections

A submission response can be lost, leaving the caller uncertain whether an order was created. Persist successful outcomes and business rejections against their idempotency keys so retries with identical inputs replay the original outcome without consuming stock again; a deliberate new attempt requires a new key. This favors a stable outcome per attempt over reevaluating a previously rejected attempt when inventory changes.

The identifier's transport is separate from this outcome policy. The user rejected the experimental Idempotency-Key HTTP header and accepted a client-generated submissionId in the JSON request body instead.
