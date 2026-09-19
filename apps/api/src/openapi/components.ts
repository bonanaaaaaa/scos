/**
 * Names and prose for the schemas the OpenAPI document publishes under
 * `components.schemas`. The schemas themselves are the ones the endpoints
 * validate with and serialize to; this module only names them and documents
 * what JSON Schema cannot express.
 *
 * Requests and responses are converted separately (`io: "input"` and
 * `io: "output"`), so each has its own registry; their names never overlap.
 *
 * @module
 */

import { MAX_QUANTITY } from "@scos/core";
import { z } from "zod";

import { healthResponseSchema } from "../endpoints/health/contract";
import {
  orderAllocationSchema,
  orderResponseSchema,
  rejectedSubmissionResponseSchema,
  submissionIdFieldSchema,
  submitOrderRequestSchema,
} from "../endpoints/submit-order/contract";
import { verifyOrderRequestSchema } from "../endpoints/verify-order/contract";
import {
  ERROR_CODES,
  errorBodySchema,
  errorCodeSchema,
  errorIssueSchema,
  errorResponseSchema,
} from "../http/errors";
import {
  estimateAllocationSchema,
  estimateResponseSchema,
  insufficientStockEstimateSchema,
  shippingExceedsLimitEstimateSchema,
  validEstimateSchema,
} from "../http/estimate";
import {
  destinationResponseSchema,
  discountRateSchema,
  latitudeFieldSchema,
  longitudeFieldSchema,
  moneySchema,
  quantityFieldSchema,
  warehouseIdSchema,
} from "../http/schemas";

export interface ComponentMeta {
  /** The name under `components.schemas`. */
  readonly id: string;
  readonly description: string;
}

export type ComponentRegistry = z.core.$ZodRegistry<ComponentMeta>;

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

const MONEY_DESCRIPTION =
  'A non-negative USD amount as a decimal string with exactly two fractional digits, such as "150.00"; never a JSON number, so no precision is lost. At most "9999999999.99".';

const REQUEST_COMPONENTS: readonly (readonly [z.ZodType, ComponentMeta])[] = [
  [
    verifyOrderRequestSchema,
    {
      id: "VerifyOrderRequest",
      description: "Quantity and destination to estimate. Unknown fields are rejected.",
    },
  ],
  [
    submitOrderRequestSchema,
    {
      id: "SubmitOrderRequest",
      description:
        "The order to submit and its submissionId. Unknown fields are rejected. The same submissionId with the same quantity and destination is a repeat.",
    },
  ],
  [
    quantityFieldSchema,
    {
      id: "Quantity",
      description: `Number of units: a JSON integer from 1 to ${MAX_QUANTITY} inclusive (the largest quantity whose subtotal fits the stored amount). Strings such as "10" are rejected, not coerced.`,
    },
  ],
  [
    latitudeFieldSchema,
    {
      id: "Latitude",
      description: "Destination latitude in decimal degrees, -90 to 90 inclusive. A JSON number.",
    },
  ],
  [
    longitudeFieldSchema,
    {
      id: "Longitude",
      description:
        "Destination longitude in decimal degrees, -180 to 180 inclusive. A JSON number.",
    },
  ],
  [submissionIdFieldSchema, { id: "SubmissionId", description: SUBMISSION_ID_DESCRIPTION }],
];

const RESPONSE_COMPONENTS: readonly (readonly [z.ZodType, ComponentMeta])[] = [
  [healthResponseSchema, { id: "HealthResponse", description: "The process is running." }],
  [
    estimateResponseSchema,
    {
      id: "OrderEstimate",
      description:
        "An advisory Order Estimate: valid, or one of the two business rejections (see `reason`).",
    },
  ],
  [
    validEstimateSchema,
    {
      id: "ValidEstimate",
      description: "The Order can be fulfilled from current stock within the shipping limit.",
    },
  ],
  [
    shippingExceedsLimitEstimateSchema,
    {
      id: "ShippingExceedsLimitEstimate",
      description:
        "Shipping exceeds 15% of the discounted merchandise total. Every amount and allocation is kept.",
    },
  ],
  [
    insufficientStockEstimateSchema,
    {
      id: "InsufficientStockEstimate",
      description:
        "All warehouses together cannot supply the quantity. Merchandise and discount amounts are kept; `shippingCost` and `orderTotal` are null and `allocations` is empty.",
    },
  ],
  [
    estimateAllocationSchema,
    {
      id: "EstimateAllocation",
      description:
        "Units taken from one warehouse, nearest first, with the unrounded great-circle distance in km used to price shipping.",
    },
  ],
  [
    destinationResponseSchema,
    { id: "Destination", description: "The requested destination, echoed back." },
  ],
  [moneySchema, { id: "Money", description: MONEY_DESCRIPTION }],
  [
    discountRateSchema,
    {
      id: "DiscountRate",
      description:
        'The volume discount rate applied, as a two-decimal string from "0.00" to "1.00", such as "0.05".',
    },
  ],
  [
    warehouseIdSchema,
    {
      id: "WarehouseId",
      description:
        "A warehouse's ID in canonical UUID form (8-4-4-4-12 hex digits). Warehouses are created with UUIDv7 IDs (the seeded warehouses and the database default), but the version is not guaranteed: treat it as an opaque identifier.",
    },
  ],
  [
    orderResponseSchema,
    {
      id: "Order",
      description:
        "An accepted Order: its amounts are the historical facts at acceptance. `orderNumber` is `SO-` followed by 12 Crockford base32 characters; `submissionId` is the key it was accepted with. The internal database id is never exposed.",
    },
  ],
  [
    orderAllocationSchema,
    { id: "OrderAllocation", description: "Units of an accepted Order taken from one warehouse." },
  ],
  [
    rejectedSubmissionResponseSchema,
    {
      id: "RejectedSubmission",
      description:
        "A business rejection and the estimate that caused it. Nothing was stored and no submissionId was consumed.",
    },
  ],
  [
    errorResponseSchema,
    {
      id: "ErrorResponse",
      description:
        "The body of every non-2xx response except a `422` submission rejection, which is `RejectedSubmission`: the same `error` object plus the `estimate`.",
    },
  ],
  [errorBodySchema, { id: "ErrorBody", description: "What went wrong." }],
  [
    errorCodeSchema,
    {
      id: "ErrorCode",
      description: `Machine-readable error code: ${ERROR_CODES.map((code) => `\`${code}\``).join(", ")}.`,
    },
  ],
  [
    errorIssueSchema,
    {
      id: "ErrorIssue",
      description:
        "One schema failure: `path` locates it in the request body (`[]` is the body itself, for example an unknown field).",
    },
  ],
];

function registryOf(entries: readonly (readonly [z.ZodType, ComponentMeta])[]): ComponentRegistry {
  const registry = z.registry<ComponentMeta>();
  for (const [schema, meta] of entries) {
    registry.add(schema, meta);
  }
  return registry;
}

/** A fresh registry of the request (input) components. */
export function requestComponentRegistry(): ComponentRegistry {
  return registryOf(REQUEST_COMPONENTS);
}

/** A fresh registry of the response (output) components. */
export function responseComponentRegistry(): ComponentRegistry {
  return registryOf(RESPONSE_COMPONENTS);
}
