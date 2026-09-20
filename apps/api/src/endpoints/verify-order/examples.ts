/**
 * OpenAPI examples of `POST /api/v1/orders/verify`, next to its contract.
 *
 * Every request example produces the paired response against a freshly
 * seeded database, so "Try it out" in `/docs` shows the documented outcome.
 * The scenarios and estimates are shared with submission
 * (`http/estimate-examples.ts`).
 *
 * @module
 */

import { errorBody } from "#http/errors";
import {
  insufficientStockEstimateExample,
  insufficientStockRequest,
  shippingExceedsLimitEstimateExample,
  shippingExceedsLimitRequest,
  validEstimateExample,
  validRequest,
} from "#http/estimate-examples";
import { MESSAGES } from "#http/messages";
import { type ExampleMap, invalidRequestExamples } from "#http/route-contract";

/** A string quantity, an out-of-range latitude and an unknown field. */
export const malformedRequest = {
  quantity: "10",
  latitude: 95,
  longitude: 13.405,
  giftWrap: true,
} as const;

export const verifyOrderRequestExamples = {
  validEstimate: {
    summary: "Valid estimate",
    description: "150 units to Berlin, allocated from the Warsaw warehouse.",
    value: validRequest,
  },
  insufficientStock: {
    summary: "Insufficient stock",
    description: "3,000 units: more than the total stock of every warehouse.",
    value: insufficientStockRequest,
  },
  shippingExceedsLimit: {
    summary: "Shipping over the limit",
    description: "10 units to Sydney: shipping from Hong Kong exceeds 15% of the merchandise.",
    value: shippingExceedsLimitRequest,
  },
  malformed: {
    summary: "Malformed request (400)",
    description:
      "A string quantity (not coerced), a latitude above 90 and an unknown field. Returns `400` with one issue each.",
    value: malformedRequest,
  },
} as const satisfies ExampleMap;

export const verifyOrderResponseExamples = {
  200: {
    validEstimate: {
      summary: "Valid estimate",
      value: validEstimateExample,
    },
    insufficientStock: {
      summary: "Insufficient stock",
      description:
        "Merchandise and discount amounts are kept; `shippingCost` and `orderTotal` are null and `allocations` is empty.",
      value: insufficientStockEstimateExample,
    },
    shippingExceedsLimit: {
      summary: "Shipping over the limit",
      description: "Every amount and allocation is kept so the client can show why.",
      value: shippingExceedsLimitEstimateExample,
    },
  },
  400: {
    malformed: {
      summary: "Schema failures, one issue each",
      value: errorBody("INVALID_REQUEST", MESSAGES.invalidBody, [
        { path: ["quantity"], message: "Invalid input: expected number, received string" },
        { path: ["latitude"], message: "Too big: expected number to be <=90" },
        { path: [], message: 'Unrecognized key: "giftWrap"' },
      ]),
    },
    ...invalidRequestExamples,
  },
  500: {
    internalError: {
      summary: "Unexpected error",
      description: "For example the database is unreachable. Nothing is stored; retrying is safe.",
      value: errorBody("INTERNAL_ERROR", MESSAGES.internal),
    },
  },
} as const satisfies Readonly<Record<number, ExampleMap>>;
