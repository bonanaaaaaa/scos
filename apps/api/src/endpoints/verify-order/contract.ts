/**
 * Contract of `POST /api/v1/orders/verify`.
 *
 * @module
 */

import { z } from "zod";

import { errorResponseSchema } from "#http/errors";
import { estimateResponseSchema } from "#http/estimate";
import { API_PREFIX, invalidRequestResponse, type RouteContract } from "#http/route-contract";
import { latitudeFieldSchema, longitudeFieldSchema, quantityFieldSchema } from "#http/schemas";
import {
  verifyOrderRequestExamples,
  verifyOrderResponseExamples,
} from "#endpoints/verify-order/examples";

/** Body of `POST /api/v1/orders/verify`. Unknown fields are rejected. */
export const verifyOrderRequestSchema = z
  .strictObject({
    quantity: quantityFieldSchema,
    latitude: latitudeFieldSchema,
    longitude: longitudeFieldSchema,
  })
  .meta({
    id: "VerifyOrderRequest",
    description: "Quantity and destination to estimate. Unknown fields are rejected.",
  });

export type VerifyOrderRequest = z.input<typeof verifyOrderRequestSchema>;

/** 200 body of `POST /api/v1/orders/verify`: an advisory Order Estimate. */
export const verifyOrderResponseSchema = estimateResponseSchema;

export type VerifyOrderResponse = z.output<typeof verifyOrderResponseSchema>;

export const verifyOrderRoute = {
  servedBy: "createVerifyOrderApp",
  operationId: "verifyOrder",
  method: "post",
  path: `${API_PREFIX}/orders/verify`,
  summary: "Advisory Order Estimate against current stock; reserves and stores nothing.",
  description: [
    "Prices and allocates the requested quantity against current Warehouse Inventory: the volume discount, nearest-first allocation, and the shipping charge with its limit of 15% of the discounted merchandise total.",
    "The estimate is advisory: no Order is created and no stock is reserved or deducted, so a later submission is recalculated against the stock at that time and may cost more or be rejected. Business rejections are returned as `200` with `valid: false`, never as errors.",
  ].join("\n\n"),
  requestBody: verifyOrderRequestSchema,
  requestExamples: verifyOrderRequestExamples,
  responses: {
    200: {
      description:
        "The estimate, valid or not. `valid: false` with `SHIPPING_EXCEEDS_LIMIT` keeps every amount and allocation; `INSUFFICIENT_STOCK` has null `shippingCost` and `orderTotal` and empty `allocations`.",
      schema: verifyOrderResponseSchema,
      examples: verifyOrderResponseExamples[200],
    },
    400: { ...invalidRequestResponse, examples: verifyOrderResponseExamples[400] },
    500: {
      description:
        "INTERNAL_ERROR: an unexpected error, including any database failure. No internals are exposed. Verification stores nothing, so the request may be retried.",
      schema: errorResponseSchema,
      examples: verifyOrderResponseExamples[500],
    },
  },
} as const satisfies RouteContract;
