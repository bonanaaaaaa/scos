/**
 * HTTP server instrumentation: one SERVER span and one
 * `http.server.request.duration` measurement per request, recorded by a Hono
 * middleware around the unchanged endpoint apps.
 *
 * This is the only HTTP instrumentation: `@opentelemetry/instrumentation-http`
 * and database auto-instrumentation are deliberately not enabled, so no
 * request or query is traced twice (docs/observability.md).
 *
 * - Incoming W3C `traceparent`/`tracestate` are extracted with the standard
 *   propagator. An invalid header is ignored and the request starts a new
 *   trace.
 * - The request runs inside the span's context (AsyncLocalStorage), so use
 *   case and persistence spans and Pino records nest under it, and concurrent
 *   requests never see each other's context.
 * - Attributes follow the stable HTTP semantic conventions. `http.route` is
 *   the matched route template and is omitted when no route matched; the
 *   query string is never recorded.
 * - Status is ERROR for 5xx responses only. 4xx (including business
 *   rejections) leave it unset, as the conventions require for server spans.
 *
 * @module
 */

import {
  type Attributes,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  context,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import type { Hono, MiddlewareHandler } from "hono";

import { createEndpointApp, routeTemplate } from "#http/endpoint-app";
import { type Logger, type StructuredLogger, defaultLogger } from "#http/logger";
import { MESSAGES } from "#http/messages";
import { type Telemetry, recordFailure } from "#telemetry/telemetry";

const KNOWN_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

const headerGetter: TextMapGetter<Headers> = {
  keys: (headers) => [...headers.keys()],
  get: (headers, key) => headers.get(key) ?? undefined,
};

function spanName(method: string | undefined, route: string | undefined): string {
  if (method === undefined) {
    return route === undefined ? "HTTP" : `HTTP ${route}`;
  }
  return route === undefined ? method : `${method} ${route}`;
}

/** Whether `logger` can write the per-request record (fakes may only have `error`). */
function isStructured(logger: Logger): logger is StructuredLogger {
  return typeof (logger as Partial<StructuredLogger>).info === "function";
}

/** Runs telemetry bookkeeping; a failure in it must never affect the request. */
function guarded(work: () => void): void {
  try {
    work();
  } catch {
    // Deliberately ignored: telemetry is best effort and never changes the
    // response. The SDK reports its own export problems through diagnostics.
  }
}

/**
 * The middleware; `logger` receives one `request completed` record per
 * request. All telemetry work is guarded: if starting the span fails the
 * request runs uninstrumented, and when it ends the span is ended and the
 * duration recorded before the (also guarded) request log is written.
 */
export function httpServerTelemetry(
  telemetry: Telemetry,
  logger?: StructuredLogger,
): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    let begun:
      | {
          readonly span: Span;
          readonly active: ReturnType<typeof trace.setSpan>;
          readonly known: string | undefined;
          readonly common: Attributes;
          readonly path: string;
        }
      | undefined;
    guarded(() => {
      const rawMethod = c.req.method;
      const known = KNOWN_METHODS.has(rawMethod) ? rawMethod : undefined;
      const url = new URL(c.req.url);
      const common: Attributes = {
        [ATTR_HTTP_REQUEST_METHOD]: known ?? "_OTHER",
        [ATTR_URL_SCHEME]: url.protocol.slice(0, -1),
      };
      const parent = telemetry.propagator.extract(ROOT_CONTEXT, c.req.raw.headers, headerGetter);
      const span = telemetry.tracer.startSpan(
        spanName(known, undefined),
        {
          kind: SpanKind.SERVER,
          attributes: {
            ...common,
            ...(known === undefined ? { [ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: rawMethod } : {}),
            [ATTR_URL_PATH]: url.pathname,
          },
        },
        parent,
      );
      begun = { span, active: trace.setSpan(parent, span), known, common, path: url.pathname };
    });
    if (begun === undefined) {
      await next();
      return;
    }
    const { span, active, known, common, path } = begun;

    await context.with(active, async () => {
      try {
        await next();
      } finally {
        let completed: Attributes | undefined;
        let seconds = 0;
        try {
          guarded(() => {
            // The app's error handler has already turned any thrown error into
            // a response and kept it on `c.error`; a 4xx with an error
            // (malformed JSON) is not a failure.
            const status = c.res.status;
            const route = routeTemplate(c);
            const attributes: Attributes = {
              ...common,
              [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
              ...(route === undefined ? {} : { [ATTR_HTTP_ROUTE]: route }),
            };
            if (status >= 500) {
              attributes[ATTR_ERROR_TYPE] =
                c.error === undefined ? String(status) : recordFailure(span, c.error);
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
            span.updateName(spanName(known, route));
            span.setAttributes(attributes);
            seconds = (performance.now() - started) / 1000;
            telemetry.httpServerDuration.record(seconds, attributes);
            completed = attributes;
          });
        } finally {
          guarded(() => span.end());
        }
        const attributes = completed;
        if (attributes !== undefined) {
          guarded(() =>
            logger?.info("request completed", {
              ...attributes,
              [ATTR_URL_PATH]: path,
              "http.server.request.duration": seconds,
            }),
          );
        }
      }
    });
  };
}

/**
 * Wraps a complete app (an endpoint app or `createApp`) with
 * {@link httpServerTelemetry}. Responses are unchanged: mounted routes keep
 * their own error handlers, and anything unmatched gets the same 404
 * envelope.
 */
export function instrumentApp(
  app: Hono,
  telemetry: Telemetry,
  logger: Logger = defaultLogger,
): Hono {
  const instrumented = createEndpointApp(logger, () => MESSAGES.internal);
  instrumented.use("*", httpServerTelemetry(telemetry, isStructured(logger) ? logger : undefined));
  instrumented.route("/", app);
  return instrumented;
}
