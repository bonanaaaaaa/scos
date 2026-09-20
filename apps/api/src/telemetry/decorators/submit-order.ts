/**
 * Traces the SubmitOrder use case and counts `scos.order.submissions`.
 *
 * @module
 */

import type { SubmitOrder, SubmitOrderOutcome } from "@scos/core";
import { type Attributes, SpanStatusCode } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";

import { sanitizeError } from "#telemetry/log-record";
import {
  ATTR_SUBMISSION_OUTCOME,
  ATTR_SUBMISSION_REJECTION_REASON,
  ATTR_SUBMISSION_REPLAYED,
  type SubmissionOutcome,
  type Telemetry,
} from "#telemetry/telemetry";
import { inSpan } from "#telemetry/decorators/span";

/** The bounded counter/span attributes of a completed SubmitOrder call. */
export function submissionAttributes(outcome: SubmitOrderOutcome): Attributes {
  const replayed = outcome.kind === "accepted" && outcome.replayed;
  const attributes: Attributes = {
    [ATTR_SUBMISSION_OUTCOME]: outcome.kind satisfies SubmissionOutcome,
    [ATTR_SUBMISSION_REPLAYED]: replayed,
  };
  if (outcome.kind === "rejected") {
    attributes[ATTR_SUBMISSION_REJECTION_REASON] = outcome.reason;
  }
  return attributes;
}

/**
 * Traces SubmitOrder and counts `scos.order.submissions` exactly once per
 * call, whatever its outcome: new Orders, replays, rejections, conflicts,
 * `invalid`, `unavailable` and thrown errors (`error`). Retries happen inside
 * the use case, so they are never counted twice. Requests rejected by HTTP
 * validation (400) never reach the use case and are not counted.
 */
export function traceSubmitOrder(submitOrder: SubmitOrder, telemetry: Telemetry): SubmitOrder {
  return (input) =>
    inSpan(telemetry, "SubmitOrder", async (span) => {
      let outcome: SubmitOrderOutcome;
      try {
        outcome = await submitOrder(input);
      } catch (error) {
        // The span records the failure when the error leaves `inSpan`.
        telemetry.submissions.add(1, {
          [ATTR_SUBMISSION_OUTCOME]: "error" satisfies SubmissionOutcome,
          [ATTR_SUBMISSION_REPLAYED]: false,
          [ATTR_ERROR_TYPE]: sanitizeError(error).type,
        });
        throw error;
      }
      const attributes = submissionAttributes(outcome);
      span.setAttributes(attributes);
      if (outcome.kind === "unavailable") {
        // A system failure the use case could not overcome (503), unlike a
        // business rejection or conflict, which leave the status unset.
        span.setAttribute(ATTR_ERROR_TYPE, "unavailable");
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      telemetry.submissions.add(1, attributes);
      return outcome;
    });
}
