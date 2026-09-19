/**
 * Client-facing messages of `POST /api/v1/orders`.
 *
 * @module
 */

export const SUBMIT_ORDER_MESSAGES = Object.freeze({
  conflict:
    "This submissionId was already used for an Order with a different quantity or destination. Use a new submissionId for a different order.",
  insufficientStock:
    "Available stock cannot fulfil the requested quantity. Nothing was stored; the same submissionId may be reused.",
  shippingExceedsLimit:
    "The shipping cost exceeds 15% of the discounted merchandise total. Nothing was stored; the same submissionId may be reused.",
  unavailable:
    "The order could not be processed right now and was not accepted. Retry with the same submissionId after the Retry-After delay.",
  /** The 500 message: it never implies acceptance. */
  internal:
    "An unexpected error occurred and the order could not be confirmed. Retry with the same submissionId: an accepted Order is returned, never duplicated.",
});
