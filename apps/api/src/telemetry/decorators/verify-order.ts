/**
 * Traces the VerifyOrder use case. A `valid: false` estimate is a business
 * answer and leaves the span status unset.
 *
 * @module
 */

import type { Attributes } from "@opentelemetry/api";
import type { OrderEstimate, VerifyOrder } from "@scos/core";

import type { Telemetry } from "#telemetry/telemetry";

import { ATTR_ESTIMATE_REASON, ATTR_ESTIMATE_VALID, inSpan } from "./span";

function estimateAttributes(estimate: OrderEstimate): Attributes {
  return estimate.valid
    ? { [ATTR_ESTIMATE_VALID]: true }
    : { [ATTR_ESTIMATE_VALID]: false, [ATTR_ESTIMATE_REASON]: estimate.reason };
}

export function traceVerifyOrder(verifyOrder: VerifyOrder, telemetry: Telemetry): VerifyOrder {
  return (request) =>
    inSpan(telemetry, "VerifyOrder", async (span) => {
      const estimate = await verifyOrder(request);
      // A `valid: false` estimate is a business answer, not an error.
      span.setAttributes(estimateAttributes(estimate));
      return estimate;
    });
}
