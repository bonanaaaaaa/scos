/**
 * Shared by the tracing decorators in this folder, one file per wrapped use
 * case or port: the INTERNAL span helper and the span attribute names. The
 * compositions apply the decorators, so core and persistence stay free of
 * OpenTelemetry. Runtime-neutral: they use only the injected
 * {@link Telemetry} port.
 *
 * - Each call is an INTERNAL span in the active context (the request's
 *   SERVER span), with its duration.
 * - A thrown error marks the span failed with a sanitized exception (class
 *   name and database error code only). Business outcomes (an invalid
 *   estimate, a rejection, a conflict) are returned values and leave the
 *   status unset; SubmitOrder's `unavailable` outcome (503) marks its span
 *   failed.
 * - No span or metric carries submission keys, order numbers, coordinates,
 *   SQL or messages.
 * - Spans end synchronously when the call settles. Export is batched and
 *   asynchronous, so nothing here waits on the network, least of all inside
 *   the submission transaction.
 *
 * @module
 */

import { type Span, SpanKind } from "@opentelemetry/api";

import { type Telemetry, recordFailure } from "#telemetry/telemetry";

export const ATTR_ESTIMATE_VALID = "scos.estimate.valid";
export const ATTR_ESTIMATE_REASON = "scos.estimate.reason";
export const ATTR_ORDER_FOUND = "scos.submission.order_found";
export const ATTR_WAREHOUSE_COUNT = "scos.inventory.warehouse_count";

/** Runs `work` in an active INTERNAL span that records a thrown error and ends. */
export function inSpan<T>(
  telemetry: Telemetry,
  name: string,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return telemetry.tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
