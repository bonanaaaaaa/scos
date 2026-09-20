/**
 * Contract of `POST /api/v1/orders`.
 *
 * The submissionId limits come from `@scos/core` (`submissionKeySchema`,
 * composed as-is), so the HTTP adapter and the domain cannot drift apart.
 *
 * @module
 */

import { ORDER_NUMBER_PATTERN, submissionKeySchema } from "@scos/core";
import { z } from "zod";

import {
  submitOrderRequestExamples,
  submitOrderResponseExamples,
} from "#endpoints/submit-order/examples";
import { errorResponseSchema, rejectionErrorBodySchema } from "#http/errors";
import {
  insufficientStockEstimateSchema,
  shippingExceedsLimitEstimateSchema,
} from "#http/estimate";
import {
  API_PREFIX,
  type RouteContract,
  SUBMISSION_ADR_URL,
  invalidRequestResponse,
} from "#http/route-contract";
import {
  destinationResponseSchema,
  discountRateSchema,
  latitudeFieldSchema,
  longitudeFieldSchema,
  moneySchema,
  quantityFieldSchema,
  responseQuantitySchema,
  warehouseIdSchema,
} from "#http/schemas";

/**
 * The submissionId rules JSON Schema cannot express. They are enforced by the
 * server and are the only differences between the published schema and the
 * runtime validation (unit tests check both directions).
 */
export const SUBMISSION_ID_DESCRIPTION = [
  "Client-generated retry key for one order: any string of 1 to 255 characters (Unicode code points, as JSON Schema counts them) chosen by the client. It does not have to be a UUID. Generate a new one for each new order and reuse it only to retry that order.",
  "The server also enforces these rules, which JSON Schema cannot express (a violation is `400 INVALID_REQUEST`):",
  [
    "- No leading or trailing whitespace, so blank, tab-only or newline-only keys are rejected. The key is stored exactly as sent, never trimmed.",
    "- No NUL character (U+0000).",
    "- Well-formed Unicode: no lone UTF-16 surrogates.",
  ].join("\n"),
].join("\n\n");

/**
 * Client-generated retry key: 1-255 Unicode code points, no leading or trailing
 * whitespace (so whitespace-only keys are rejected), no NUL, well-formed
 * Unicode. Core's schema, composed as-is and documented with the rules JSON
 * Schema cannot express.
 */
export const submissionIdFieldSchema = submissionKeySchema.meta({
  id: "SubmissionId",
  description: SUBMISSION_ID_DESCRIPTION,
});

/** Body of `POST /api/v1/orders`. Unknown fields are rejected. */
export const submitOrderRequestSchema = z
  .strictObject({
    submissionId: submissionIdFieldSchema,
    quantity: quantityFieldSchema,
    latitude: latitudeFieldSchema,
    longitude: longitudeFieldSchema,
  })
  .meta({
    id: "SubmitOrderRequest",
    description:
      "The order to submit and its submissionId. Unknown fields are rejected. The same submissionId with the same quantity and destination is a repeat.",
  });

export type SubmitOrderRequest = z.input<typeof submitOrderRequestSchema>;

export const orderAllocationSchema = z
  .object({
    warehouseId: warehouseIdSchema,
    quantity: responseQuantitySchema,
  })
  .meta({
    id: "OrderAllocation",
    description: "Units of an accepted Order taken from one warehouse.",
  });

/**
 * 201 body of `POST /api/v1/orders`: the accepted Order. A repeated submissionId with
 * the same inputs returns the same body. The internal database id is never
 * exposed.
 */
export const orderResponseSchema = z
  .object({
    orderNumber: z.string().regex(ORDER_NUMBER_PATTERN),
    submissionId: z.string(),
    quantity: responseQuantitySchema,
    destination: destinationResponseSchema,
    unitPrice: moneySchema,
    merchandiseSubtotal: moneySchema,
    discountRate: discountRateSchema,
    discountAmount: moneySchema,
    discountedMerchandiseTotal: moneySchema,
    shippingCost: moneySchema,
    orderTotal: moneySchema,
    allocations: z.array(orderAllocationSchema).min(1),
  })
  .meta({
    id: "Order",
    description:
      "An accepted Order: its amounts are the historical facts at acceptance. `orderNumber` is `SO-` followed by 12 Crockford base32 characters; `submissionId` is the key it was accepted with. The internal database id is never exposed.",
  });

export type OrderResponse = z.output<typeof orderResponseSchema>;

/**
 * 422 body of `POST /api/v1/orders`: the business rejection plus the estimate that
 * caused it (same shape as a `valid: false` verification). Nothing was stored.
 */
export const rejectedSubmissionResponseSchema = z
  .object({
    error: rejectionErrorBodySchema,
    estimate: z.union([shippingExceedsLimitEstimateSchema, insufficientStockEstimateSchema]),
  })
  .meta({
    id: "RejectedSubmission",
    description:
      "A business rejection and the estimate that caused it. Nothing was stored and no submissionId was consumed.",
  });

export type RejectedSubmissionResponse = z.output<typeof rejectedSubmissionResponseSchema>;

/** Seconds a client should wait before retrying after a 503. */
export const RETRY_AFTER_SECONDS = 1;

export const submitOrderRoute = {
  servedBy: "createSubmitOrderApp",
  operationId: "submitOrder",
  method: "post",
  path: `${API_PREFIX}/orders`,
  summary: "Submit an Order against current stock, deduplicated by submissionId.",
  description: [
    "Accepts or rejects the Order atomically against current stock: pricing and allocation are recalculated under lock, and acceptance saves the Order and deducts stock together.",
    "`submissionId` is a client-generated key that makes retries safe; there is no `Idempotency-Key` header. Generate a new one for each new order and reuse it only to retry that order:",
    [
      "- An accepted Order keeps its submissionId indefinitely: keys are retained as long as their Orders.",
      "- Repeating an accepted submissionId with the same quantity and destination returns the original Order (`201`, byte-identical body) without deducting stock again, even after stock changes.",
      "- Reusing it with a different quantity or destination is `409 SUBMISSION_ID_CONFLICT`; the existing Order is unchanged and not disclosed.",
      "- Business rejections (`422`), malformed requests (`400`) and transient failures (`503`) are not stored and consume no key. A rejected request can be retried with the same submissionId: it is evaluated again against current stock and may be accepted.",
      "- A `500` means the outcome is unknown (for example, the connection failed after the commit). Retry with the same submissionId and body: a stored Order is returned, never duplicated.",
    ].join("\n"),
    `See [ADR 0004: Deduplicate accepted Orders by submission key](${SUBMISSION_ADR_URL}).`,
  ].join("\n\n"),
  requestBody: submitOrderRequestSchema,
  requestExamples: submitOrderRequestExamples,
  responses: {
    201: {
      description:
        "Accepted. A repeated submissionId with the same inputs returns the original Order unchanged (byte-identical body), without deducting stock again.",
      schema: orderResponseSchema,
      examples: submitOrderResponseExamples[201],
    },
    400: { ...invalidRequestResponse, examples: submitOrderResponseExamples[400] },
    409: {
      description:
        "SUBMISSION_ID_CONFLICT: the submissionId belongs to an Order with a different quantity or destination. That Order is unchanged and not disclosed.",
      schema: errorResponseSchema,
      examples: submitOrderResponseExamples[409],
    },
    422: {
      description:
        "Business rejection (INSUFFICIENT_STOCK or SHIPPING_EXCEEDS_LIMIT) with the estimate that caused it, in the same shape as a `valid: false` verification. Rejections are not stored: the submissionId stays reusable and a repeat is re-evaluated.",
      schema: rejectedSubmissionResponseSchema,
      examples: submitOrderResponseExamples[422],
    },
    500: {
      description:
        "INTERNAL_ERROR: the order could not be confirmed and may or may not have been stored. No internals are exposed. Retry with the same submissionId and body: a stored Order is returned, never duplicated.",
      schema: errorResponseSchema,
      examples: submitOrderResponseExamples[500],
    },
    503: {
      description:
        "SERVICE_UNAVAILABLE: a transient database failure (contention that persisted through every attempt, or no database connection available in time). Nothing was stored by this request; retry with the same submissionId after Retry-After seconds.",
      schema: errorResponseSchema,
      headers: {
        "Retry-After": {
          description: "Seconds to wait before retrying.",
          schema: z.int().min(1),
          example: RETRY_AFTER_SECONDS,
        },
      },
      examples: submitOrderResponseExamples[503],
    },
  },
} as const satisfies RouteContract;
