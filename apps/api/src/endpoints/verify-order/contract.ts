/**
 * Contract of `POST /api/v1/orders/verify`.
 *
 * @module
 */

import { z } from "zod";

import { errorResponseSchema } from "../../http/errors";
import { estimateResponseSchema } from "../../http/estimate";
import { API_PREFIX, invalidRequestResponse, type RouteContract } from "../../http/route-contract";
import { latitudeFieldSchema, longitudeFieldSchema, quantityFieldSchema } from "../../http/schemas";

/** Body of `POST /api/v1/orders/verify`. Unknown fields are rejected. */
export const verifyOrderRequestSchema = z.strictObject({
  quantity: quantityFieldSchema,
  latitude: latitudeFieldSchema,
  longitude: longitudeFieldSchema,
});

export type VerifyOrderRequest = z.input<typeof verifyOrderRequestSchema>;

/** 200 body of `POST /api/v1/orders/verify`: an advisory Order Estimate. */
export const verifyOrderResponseSchema = estimateResponseSchema;

export type VerifyOrderResponse = z.output<typeof verifyOrderResponseSchema>;

export const verifyOrderRoute = {
  servedBy: "createVerifyOrderApp",
  method: "post",
  path: `${API_PREFIX}/orders/verify`,
  summary: "Advisory Order Estimate against current stock; reserves and stores nothing.",
  requestBody: verifyOrderRequestSchema,
  responses: {
    200: {
      description:
        "The estimate. `valid: false` with `SHIPPING_EXCEEDS_LIMIT` keeps every amount; `INSUFFICIENT_STOCK` has null shippingCost and orderTotal and no allocations.",
      schema: verifyOrderResponseSchema,
    },
    400: invalidRequestResponse,
    500: {
      description:
        "INTERNAL_ERROR: an unexpected error, including any database failure. No internals are exposed. Verification stores nothing, so the request may be retried.",
      schema: errorResponseSchema,
    },
  },
} as const satisfies RouteContract;
