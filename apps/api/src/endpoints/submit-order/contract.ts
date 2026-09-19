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

import { errorBodySchema, errorResponseSchema } from "../../http/errors";
import {
  insufficientStockEstimateSchema,
  shippingExceedsLimitEstimateSchema,
} from "../../http/estimate";
import { API_PREFIX, invalidRequestResponse, type RouteContract } from "../../http/route-contract";
import {
  destinationResponseSchema,
  discountRateSchema,
  latitudeFieldSchema,
  longitudeFieldSchema,
  moneySchema,
  quantityFieldSchema,
} from "../../http/schemas";

/**
 * Client-generated retry key: 1-255 UTF-16 code units, no leading or trailing
 * whitespace (so whitespace-only keys are rejected), no NUL, well-formed
 * Unicode. Core's schema, composed as-is.
 */
export const submissionIdFieldSchema = submissionKeySchema;

/** Body of `POST /api/v1/orders`. Unknown fields are rejected. */
export const submitOrderRequestSchema = z.strictObject({
  submissionId: submissionIdFieldSchema,
  quantity: quantityFieldSchema,
  latitude: latitudeFieldSchema,
  longitude: longitudeFieldSchema,
});

export type SubmitOrderRequest = z.input<typeof submitOrderRequestSchema>;

export const orderAllocationSchema = z.object({
  warehouseId: z.string(),
  quantity: z.number().int().positive(),
});

/**
 * 201 body of `POST /api/v1/orders`: the accepted Order. A repeated submissionId with
 * the same inputs returns the same body. The internal database id is never
 * exposed.
 */
export const orderResponseSchema = z.object({
  orderNumber: z.string().regex(ORDER_NUMBER_PATTERN),
  submissionId: z.string(),
  quantity: z.number().int().positive(),
  destination: destinationResponseSchema,
  unitPrice: moneySchema,
  merchandiseSubtotal: moneySchema,
  discountRate: discountRateSchema,
  discountAmount: moneySchema,
  discountedMerchandiseTotal: moneySchema,
  shippingCost: moneySchema,
  orderTotal: moneySchema,
  allocations: z.array(orderAllocationSchema).min(1),
});

export type OrderResponse = z.output<typeof orderResponseSchema>;

/**
 * 422 body of `POST /api/v1/orders`: the business rejection plus the estimate that
 * caused it (same shape as a `valid: false` verification). Nothing was stored.
 */
export const rejectedSubmissionResponseSchema = z.object({
  error: errorBodySchema.extend({
    code: z.enum(["INSUFFICIENT_STOCK", "SHIPPING_EXCEEDS_LIMIT"]),
  }),
  estimate: z.union([shippingExceedsLimitEstimateSchema, insufficientStockEstimateSchema]),
});

export type RejectedSubmissionResponse = z.output<typeof rejectedSubmissionResponseSchema>;

/** Seconds a client should wait before retrying after a 503. */
export const RETRY_AFTER_SECONDS = 1;

export const submitOrderRoute = {
  servedBy: "createSubmitOrderApp",
  method: "post",
  path: `${API_PREFIX}/orders`,
  summary: "Submit an Order against current stock, deduplicated by submissionId.",
  requestBody: submitOrderRequestSchema,
  responses: {
    201: {
      description:
        "Accepted. A repeated submissionId with the same inputs returns the original Order unchanged, without deducting stock again.",
      schema: orderResponseSchema,
    },
    400: invalidRequestResponse,
    409: {
      description:
        "SUBMISSION_ID_CONFLICT: the submissionId belongs to an Order with a different quantity or destination. That Order is unchanged and not disclosed.",
      schema: errorResponseSchema,
    },
    422: {
      description:
        "Business rejection (INSUFFICIENT_STOCK or SHIPPING_EXCEEDS_LIMIT). Rejections are not stored: the submissionId stays reusable and a repeat is re-evaluated.",
      schema: rejectedSubmissionResponseSchema,
    },
    500: {
      description:
        "INTERNAL_ERROR: the order could not be confirmed and may or may not have been stored. No internals are exposed. Retry with the same submissionId: a stored Order is returned, never duplicated.",
      schema: errorResponseSchema,
    },
    503: {
      description:
        "SERVICE_UNAVAILABLE: a transient database failure (contention that persisted through every attempt, or no database connection available in time). Nothing was stored; retry with the same submissionId after Retry-After seconds.",
      schema: errorResponseSchema,
      headers: { "Retry-After": "Seconds to wait before retrying." },
    },
  },
} as const satisfies RouteContract;
