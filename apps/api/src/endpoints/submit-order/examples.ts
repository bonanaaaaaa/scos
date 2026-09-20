/**
 * OpenAPI examples of `POST /api/v1/orders`, next to its contract.
 *
 * The request examples reuse the verification scenarios with a submissionId,
 * and produce the paired response against a freshly seeded database (the
 * conflict example after the acceptance example). Unit tests replay them
 * through the real `SubmitOrder` use case over the seed inventory and check
 * each example against its Zod and JSON schemas.
 *
 * @module
 */

import { SUBMIT_ORDER_MESSAGES } from "#endpoints/submit-order/messages";
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

/** Any client-chosen string of 1-255 characters; not necessarily a UUID. */
export const EXAMPLE_SUBMISSION_ID = "checkout-7f3a-attempt-1";

/** The order number the accepted example shows (random in practice). */
export const EXAMPLE_ORDER_NUMBER = "SO-7K2M9Q4XBV1D";

export const acceptedRequest = { submissionId: EXAMPLE_SUBMISSION_ID, ...validRequest } as const;

/** Same submissionId as {@link acceptedRequest}, one more unit. */
export const changedInputRequest = {
  ...acceptedRequest,
  quantity: validRequest.quantity + 1,
} as const;

/** Surrounding whitespace in the submissionId and a zero quantity. */
export const malformedRequest = {
  submissionId: " checkout-7f3a-attempt-1",
  quantity: 0,
  latitude: 52.52,
  longitude: 13.405,
} as const;

export const submitOrderRequestExamples = {
  accepted: {
    summary: "Accepted Order",
    description:
      "150 units to Berlin under a new submissionId. Sending it again is a repeat and returns the same Order.",
    value: acceptedRequest,
  },
  repeated: {
    summary: "Repeated submissionId (201, original Order)",
    description:
      'The "Accepted Order" request again, as after a double click or a lost response. Returns the original Order, byte-identical, without deducting stock again.',
    value: acceptedRequest,
  },
  changedInput: {
    summary: "Conflicting reuse of a submissionId (409)",
    description:
      'The submissionId of the "Accepted Order" example with a different quantity. Send it after that example.',
    value: changedInputRequest,
  },
  insufficientStock: {
    summary: "Insufficient stock (422)",
    description: "Rejected and not stored: the same submissionId may be sent again later.",
    value: { submissionId: "checkout-9b21-attempt-1", ...insufficientStockRequest },
  },
  shippingExceedsLimit: {
    summary: "Shipping over the limit (422)",
    description: "Rejected and not stored: the same submissionId may be sent again later.",
    value: { submissionId: "checkout-4c88-attempt-1", ...shippingExceedsLimitRequest },
  },
  malformed: {
    summary: "Malformed request (400)",
    description: "A submissionId with leading whitespace and a zero quantity. Consumes no key.",
    value: malformedRequest,
  },
} as const satisfies ExampleMap;

export const acceptedOrderExample = {
  orderNumber: EXAMPLE_ORDER_NUMBER,
  submissionId: EXAMPLE_SUBMISSION_ID,
  quantity: validEstimateExample.quantity,
  destination: validEstimateExample.destination,
  unitPrice: "150.00",
  merchandiseSubtotal: validEstimateExample.merchandiseSubtotal,
  discountRate: validEstimateExample.discountRate,
  discountAmount: validEstimateExample.discountAmount,
  discountedMerchandiseTotal: validEstimateExample.discountedMerchandiseTotal,
  shippingCost: validEstimateExample.shippingCost,
  orderTotal: validEstimateExample.orderTotal,
  allocations: validEstimateExample.allocations.map(({ warehouseId, quantity }) => ({
    warehouseId,
    quantity,
  })),
} as const;

export const submitOrderResponseExamples = {
  201: {
    accepted: {
      summary: "Accepted Order",
      description: "A new Order: stock was deducted and the submissionId is now bound to it.",
      value: acceptedOrderExample,
    },
    repeated: {
      summary: "Repeated submissionId: the original Order",
      description:
        "The same submissionId, quantity and destination again (a double click or a retry after a lost response). The body is byte-identical to the original response; stock is not deducted again.",
      value: acceptedOrderExample,
    },
  },
  400: {
    malformed: {
      summary: "Schema failures, one issue each",
      value: errorBody("INVALID_REQUEST", MESSAGES.invalidBody, [
        {
          path: ["submissionId"],
          message: "Submission key must not have leading or trailing whitespace.",
        },
        { path: ["quantity"], message: "Too small: expected number to be >0" },
      ]),
    },
    ...invalidRequestExamples,
  },
  409: {
    changedInput: {
      summary: "submissionId reused with different inputs",
      value: errorBody("SUBMISSION_ID_CONFLICT", SUBMIT_ORDER_MESSAGES.conflict),
    },
  },
  422: {
    insufficientStock: {
      summary: "Insufficient stock",
      value: {
        error: { code: "INSUFFICIENT_STOCK", message: SUBMIT_ORDER_MESSAGES.insufficientStock },
        estimate: insufficientStockEstimateExample,
      },
    },
    shippingExceedsLimit: {
      summary: "Shipping over the limit",
      value: {
        error: {
          code: "SHIPPING_EXCEEDS_LIMIT",
          message: SUBMIT_ORDER_MESSAGES.shippingExceedsLimit,
        },
        estimate: shippingExceedsLimitEstimateExample,
      },
    },
  },
  500: {
    internalError: {
      summary: "Unexpected error",
      description:
        "The Order may or may not have been stored. Retry with the same submissionId and body.",
      value: errorBody("INTERNAL_ERROR", SUBMIT_ORDER_MESSAGES.internal),
    },
  },
  503: {
    unavailable: {
      summary: "Transient failure",
      description: "Sent with `Retry-After: 1`. Nothing was stored by this request.",
      value: errorBody("SERVICE_UNAVAILABLE", SUBMIT_ORDER_MESSAGES.unavailable),
    },
  },
} as const satisfies Readonly<Record<number, ExampleMap>>;
