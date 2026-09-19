/**
 * HTTP contract of the SCOS API: request and response schemas, error codes and
 * the route/status table.
 *
 * This module is pure: it reads no environment, opens no connection and
 * imports no runtime adapter, so an offline OpenAPI export (#12) can import
 * it directly. The handlers in `app.ts` validate requests with these schemas
 * and type their responses with them.
 *
 * Numeric and submissionId limits come from `@scos/core` (the quantity and
 * submission-key schemas are composed as-is; coordinate limits reuse the core
 * constants), so the HTTP adapter and the domain cannot drift apart.
 *
 * @module
 */

import {
  LATITUDE_LIMIT,
  LONGITUDE_LIMIT,
  ORDER_NUMBER_PATTERN,
  quantitySchema,
  submissionKeySchema,
} from "@scos/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Positive integer, at most core's `MAX_QUANTITY`. Strings are not coerced. */
export const quantityFieldSchema = quantitySchema;

/** Finite latitude in [-LATITUDE_LIMIT, LATITUDE_LIMIT] decimal degrees, inclusive. */
export const latitudeFieldSchema = z.number().min(-LATITUDE_LIMIT).max(LATITUDE_LIMIT);

/** Finite longitude in [-LONGITUDE_LIMIT, LONGITUDE_LIMIT] decimal degrees, inclusive. */
export const longitudeFieldSchema = z.number().min(-LONGITUDE_LIMIT).max(LONGITUDE_LIMIT);

/**
 * Client-generated retry key: 1-255 UTF-16 code units, no leading or trailing
 * whitespace (so whitespace-only keys are rejected), no NUL, well-formed
 * Unicode. Core's schema, composed as-is.
 */
export const submissionIdFieldSchema = submissionKeySchema;

/** Body of `POST /orders/verify`. Unknown fields are rejected. */
export const verifyOrderRequestSchema = z.strictObject({
  quantity: quantityFieldSchema,
  latitude: latitudeFieldSchema,
  longitude: longitudeFieldSchema,
});

/** Body of `POST /orders`. Unknown fields are rejected. */
export const submitOrderRequestSchema = z.strictObject({
  submissionId: submissionIdFieldSchema,
  quantity: quantityFieldSchema,
  latitude: latitudeFieldSchema,
  longitude: longitudeFieldSchema,
});

export type VerifyOrderRequest = z.input<typeof verifyOrderRequestSchema>;
export type SubmitOrderRequest = z.input<typeof submitOrderRequestSchema>;

// ---------------------------------------------------------------------------
// Shared response parts
// ---------------------------------------------------------------------------

/** A non-negative USD amount with exactly two fractional digits, e.g. "150.00". */
export const moneySchema = z.string().regex(/^\d{1,10}\.\d{2}$/);

/** The volume discount rate applied, as a two-decimal string, e.g. "0.05". */
export const discountRateSchema = z.string().regex(/^(?:0\.\d{2}|1\.00)$/);

export const destinationResponseSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const estimateAllocationSchema = z.object({
  warehouseId: z.string(),
  quantity: z.number().int().positive(),
  /** Great-circle distance from the warehouse to the destination, unrounded. */
  distanceKm: z.number().nonnegative(),
});

export const orderAllocationSchema = z.object({
  warehouseId: z.string(),
  quantity: z.number().int().positive(),
});

const estimateBaseShape = {
  quantity: z.number().int().positive(),
  destination: destinationResponseSchema,
  merchandiseSubtotal: moneySchema,
  discountRate: discountRateSchema,
  discountAmount: moneySchema,
  discountedMerchandiseTotal: moneySchema,
};

export const validEstimateSchema = z.object({
  valid: z.literal(true),
  reason: z.null(),
  ...estimateBaseShape,
  shippingCost: moneySchema,
  orderTotal: moneySchema,
  allocations: z.array(estimateAllocationSchema).min(1),
});

export const shippingExceedsLimitEstimateSchema = z.object({
  valid: z.literal(false),
  reason: z.literal("SHIPPING_EXCEEDS_LIMIT"),
  ...estimateBaseShape,
  shippingCost: moneySchema,
  orderTotal: moneySchema,
  allocations: z.array(estimateAllocationSchema).min(1),
});

export const insufficientStockEstimateSchema = z.object({
  valid: z.literal(false),
  reason: z.literal("INSUFFICIENT_STOCK"),
  ...estimateBaseShape,
  shippingCost: z.null(),
  orderTotal: z.null(),
  allocations: z.array(estimateAllocationSchema).max(0),
});

/** 200 body of `POST /orders/verify`: an advisory Order Estimate. */
export const verifyOrderResponseSchema = z.union([
  validEstimateSchema,
  shippingExceedsLimitEstimateSchema,
  insufficientStockEstimateSchema,
]);

export type VerifyOrderResponse = z.output<typeof verifyOrderResponseSchema>;
export type RejectedEstimate =
  | z.output<typeof shippingExceedsLimitEstimateSchema>
  | z.output<typeof insufficientStockEstimateSchema>;

/**
 * 201 body of `POST /orders`: the accepted Order. A repeated submissionId with
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "SUBMISSION_ID_CONFLICT",
  "INSUFFICIENT_STOCK",
  "SHIPPING_EXCEEDS_LIMIT",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.output<typeof errorCodeSchema>;

export const errorIssueSchema = z.object({
  /** Location of the problem in the request body; `[]` is the body itself. */
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export type ErrorIssue = z.output<typeof errorIssueSchema>;

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  issues: z.array(errorIssueSchema).optional(),
});

/** The envelope of every non-2xx response. */
export const errorResponseSchema = z.object({ error: errorBodySchema });

export type ErrorResponse = z.output<typeof errorResponseSchema>;

/**
 * 422 body of `POST /orders`: the business rejection plus the estimate that
 * caused it (same shape as a `valid: false` verification). Nothing was stored.
 */
export const rejectedSubmissionResponseSchema = z.object({
  error: errorBodySchema.extend({
    code: z.enum(["INSUFFICIENT_STOCK", "SHIPPING_EXCEEDS_LIMIT"]),
  }),
  estimate: z.union([shippingExceedsLimitEstimateSchema, insufficientStockEstimateSchema]),
});

export type RejectedSubmissionResponse = z.output<typeof rejectedSubmissionResponseSchema>;

export const healthResponseSchema = z.object({ status: z.literal("ok") });

/** Seconds a client should wait before retrying after a 503. */
export const RETRY_AFTER_SECONDS = 1;

// ---------------------------------------------------------------------------
// Route and status contract
// ---------------------------------------------------------------------------

export interface ResponseContract {
  readonly description: string;
  readonly schema: z.ZodType;
  /** Response headers the client can rely on, by name. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RouteContract {
  readonly method: "get" | "post";
  readonly path: string;
  readonly summary: string;
  readonly requestBody?: z.ZodType;
  readonly responses: Readonly<Record<number, ResponseContract>>;
}

const invalidRequest: ResponseContract = {
  description:
    "Malformed request: invalid JSON, a missing or non-JSON Content-Type, unknown fields, or a value outside the documented limits. Nothing is stored and no submissionId is consumed.",
  schema: errorResponseSchema,
};

const internalError: ResponseContract = {
  description:
    "Unexpected server error, including any database failure on POST /orders/verify. No internals are exposed. It never confirms an Order, but on POST /orders it does not guarantee that none was stored either: retry with the same submissionId, which returns the Order if one was committed.",
  schema: errorResponseSchema,
};

/**
 * Every route the API serves with each documented status. Any other path
 * returns 404 with `errorResponseSchema` and code `NOT_FOUND`.
 */
export const routes = {
  health: {
    method: "get",
    path: "/health",
    summary: "Liveness check; does not touch the database.",
    responses: {
      200: { description: "The process is running.", schema: healthResponseSchema },
    },
  },
  verifyOrder: {
    method: "post",
    path: "/orders/verify",
    summary: "Advisory Order Estimate against current stock; reserves and stores nothing.",
    requestBody: verifyOrderRequestSchema,
    responses: {
      200: {
        description:
          "The estimate. `valid: false` with `SHIPPING_EXCEEDS_LIMIT` keeps every amount; `INSUFFICIENT_STOCK` has null shippingCost and orderTotal and no allocations.",
        schema: verifyOrderResponseSchema,
      },
      400: invalidRequest,
      500: internalError,
    },
  },
  submitOrder: {
    method: "post",
    path: "/orders",
    summary: "Submit an Order against current stock, deduplicated by submissionId.",
    requestBody: submitOrderRequestSchema,
    responses: {
      201: {
        description:
          "Accepted. A repeated submissionId with the same inputs returns the original Order unchanged, without deducting stock again.",
        schema: orderResponseSchema,
      },
      400: invalidRequest,
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
      500: internalError,
      503: {
        description:
          "SERVICE_UNAVAILABLE: a transient database failure (contention that persisted through every attempt, or no database connection available in time). Nothing was stored; retry with the same submissionId after Retry-After seconds.",
        schema: errorResponseSchema,
        headers: { "Retry-After": "Seconds to wait before retrying." },
      },
    },
  },
} as const satisfies Record<string, RouteContract>;

/** Body of a 404 for any path or method not in {@link routes}. */
export const notFoundResponse: ResponseContract = {
  description: "No such route.",
  schema: errorResponseSchema,
};
