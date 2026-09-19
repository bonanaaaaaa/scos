# Observability

SCOS emits three OpenTelemetry-aligned signals from `apps/api` (issue #17):

| Signal  | How it is produced                                                                         | Where it goes                                                         |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Logs    | Pino JSON, one line per call, on stdout; `PinoInstrumentation` adds trace correlation only | stdout, collected by the platform (CloudWatch Logs) or a Collector    |
| Traces  | Manual spans: one SERVER span per request, plus use-case and persistence-port spans        | OTLP/HTTP (protobuf) or the console, through a bounded batch exporter |
| Metrics | `http.server.request.duration` histogram and `scos.order.submissions` counter              | OTLP/HTTP (protobuf) or the console, through a periodic reader        |

The domain and persistence packages (`packages/core`, `packages/persistence`)
have no OpenTelemetry dependency. Their ports are wrapped by decorators in
the API compositions.

![Telemetry in the SCOS hexagonal architecture](images/telemetry-hexagon.svg)

## Runtime-neutral ports and the Node/Lambda composition

Telemetry sits behind ports that do not depend on a runtime. The runtime's
composition wires them.

| Module                              | Runtime | Contents                                                                                                                                                                                                   |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http/logger.ts`                | neutral | `Logger` / `StructuredLogger` ports; `createConsoleJsonLogger`, the default when nothing is injected                                                                                                       |
| `src/telemetry/log-record.ts`       | neutral | The log record contract: severity mapping, redaction keys, error sanitizing, correlation fields, resource fields                                                                                           |
| `src/telemetry/telemetry.ts`        | neutral | The `Telemetry` port (tracer, propagator, histogram, counter), built from any providers                                                                                                                    |
| `src/telemetry/http.ts`             | neutral | Hono middleware: SERVER span, HTTP attributes, duration histogram, request log                                                                                                                             |
| `src/telemetry/decorators/`         | neutral | One file per wrapped use case or port: `verify-order.ts`, `submit-order.ts` (plus the counter), `inventory-reader.ts`, `submission-store.ts` (and its transaction); `span.ts` holds the shared span helper |
| `src/telemetry/config.ts`           | neutral | Zod schema for the telemetry variables                                                                                                                                                                     |
| `src/telemetry/node/sdk.ts`         | Node    | SDK providers, exporters, AsyncLocalStorage context manager, `PinoInstrumentation`, flush and shutdown (`startTelemetry`)                                                                                  |
| `src/telemetry/node/pino-logger.ts` | Node    | The Pino adapter, loaded after instrumentation is registered                                                                                                                                               |

The neutral modules import only `@opentelemetry/api`, the
semantic-convention constants, Zod, Hono and our own ports. They never read
`process.env`. `src/runtime-boundary.test.ts` enforces this. The apps, the
middleware and the decorators receive the `Telemetry` object and the logger
through their app and composition options. When no telemetry is passed,
nothing is instrumented, so pure app construction and tests need no SDK.

### Workers runtime (follow-up PR under #17)

A Cloudflare Workers composition is **not part of this change**. It will
arrive in a follow-up PR under #17 and plug into the same ports:

- a Workers `Telemetry` object for `createTelemetry` (a tracer provider, a
  meter provider and the W3C propagator), passed to the unchanged
  middleware and decorators;
- a `StructuredLogger` that writes the log record contract below to
  `console.log`. `createConsoleJsonLogger` already produces the same fields,
  including trace correlation from the active span;
- the same Zod telemetry schema, extended for Workers bindings.

Nothing Node-specific (`telemetry/node/`, Pino, `PinoInstrumentation`,
`AsyncLocalStorageContextManager` wiring, periodic readers) is used there.

## Log record contract

Every logger adapter (Pino on Node/Lambda, and the console JSON logger)
writes one JSON object per call, as a single line:

```json
{
  "level": "info",
  "severity_number": 9,
  "time": "2026-09-19T10:18:16.669Z",
  "service.name": "scos-api",
  "service.version": "0.0.0-issue17",
  "deployment.environment.name": "local",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "034e972941900f13",
  "trace_flags": "01",
  "http.request.method": "POST",
  "url.scheme": "http",
  "http.response.status_code": 200,
  "http.route": "/api/v1/orders/verify",
  "url.path": "/api/v1/orders/verify",
  "http.server.request.duration": 0.08573370799999998,
  "msg": "request completed"
}
```

### Mapping to the OTel LogRecord model

| JSON field                                                       | [OTel LogRecord](https://opentelemetry.io/docs/specs/otel/logs/data-model/) field | Notes                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `time`                                                           | `Timestamp`                                                                       | ISO 8601 UTC with milliseconds (`pino.stdTimeFunctions.isoTime`)                          |
| (collection time)                                                | `ObservedTimestamp`                                                               | Set by the collector or platform                                                          |
| `level`                                                          | `SeverityText`                                                                    | Pino level label                                                                          |
| `severity_number`                                                | `SeverityNumber`                                                                  | See the table below                                                                       |
| `msg`                                                            | `Body`                                                                            | A short message; request data goes in attributes, never in the body                       |
| `trace_id`, `span_id`, `trace_flags`                             | `TraceId`, `SpanId`, `TraceFlags`                                                 | Only when a valid span context is active; never invented; `trace_flags` is `01` or `00`   |
| `service.name`, `service.version`, `deployment.environment.name` | `Resource`                                                                        | Pino `base` fields; the same values as the span and metric resource                       |
| every other key                                                  | `Attributes`                                                                      | For example the HTTP attributes of the request log, or `diagnostic`                       |
| (none)                                                           | `InstrumentationScope`                                                            | Logs have no scope field; a collector may set `@scos/api`, the traces' and metrics' scope |

`submissionId`, order numbers and database IDs are business identifiers.
They are never used as, or confused with, `trace_id`/`span_id`, and they are
not logged.

### Severity

| Pino level | `level` | `severity_number` | OTel severity range |
| ---------- | ------- | ----------------- | ------------------- |
| 10         | `trace` | 1                 | TRACE (1-4)         |
| 20         | `debug` | 5                 | DEBUG (5-8)         |
| 30         | `info`  | 9                 | INFO (9-12)         |
| 40         | `warn`  | 13                | WARN (13-16)        |
| 50         | `error` | 17                | ERROR (17-20)       |
| 60         | `fatal` | 21                | FATAL (21-24)       |

`LOG_LEVEL=silent` writes nothing. The numbers are the same mapping
`@opentelemetry/instrumentation-pino` uses when it sends logs itself.

### Redaction and error sanitizing

- The keys `authorization`, `cookie`, `password`, `token`, `secret`,
  `databaseUrl`, `DATABASE_URL`, `connectionString`, `body`, `latitude`,
  `longitude` and `destination` are replaced with `"[REDACTED]"` at the top
  level and one level down (which includes `headers.*`). Pino uses its
  `redact` paths; the console logger uses `redact()` from the same list.
- An `Error` value in log details becomes `{ type, code?, sqlState?, stack }`:
  the class name, the PostgreSQL SQLSTATE when known (otherwise a Prisma
  code), from the error or its `cause`, and stack frames only. The message is
  dropped, because database and driver messages can contain SQL, parameters
  or connection details.
- **Reserved keys.** Details and child bindings can never set the fields the
  logger owns: `level`, `severity_number`, `severity_text`, `time`, `msg`,
  `trace_id`, `span_id`, `trace_flags`, `service.*` and
  `deployment.environment.name`. Such a key is written with a `detail.`
  prefix instead (`{ trace_id: "sub-123" }` becomes
  `"detail.trace_id": "sub-123"`), so a record never has duplicate keys and a
  business identifier can never pose as trace correlation. Both adapters
  apply the same rule (`sanitizeDetails` in `log-record.ts`).
- The unhandled-error record (`Unhandled error while handling a request`)
  uses the same keys as the request log: `http.request.method`, `url.path`
  and `http.route` when a route matched.
- Code never logs request bodies, credentials, coordinates, submission IDs or
  order numbers in the first place. Redaction is a second line of defence.

### Collection path

The API writes logs to stdout and nothing else: there is no OTel Logs SDK,
no `LoggerProvider`, no OTLP log exporter and no `pino-opentelemetry-transport`.
The JavaScript Logs SDK is still in Development, while traces and metrics are
Stable.

- **Lambda (#14/#15):** the runtime ships stdout to CloudWatch Logs. Parse
  the JSON (for example CloudWatch Logs Insights, a subscription filter, or
  the ADOT Lambda layer's Collector) and map fields with the table above.
- **Containers or local:** send container stdout to an OpenTelemetry
  Collector `filelog` receiver with a `json_parser` operator. Map `time` to
  timestamp, `level`/`severity_number` to severity, `msg` to body,
  `trace_id`/`span_id`/`trace_flags` to the trace fields, and the
  `service.*`/`deployment.*` keys to resource attributes.
- Each call is exactly one line, so line-based collectors never split or
  merge records.

`PinoInstrumentation` (with `disableLogSending: true` and
`disableLogCorrelation: false`) only adds `trace_id`, `span_id` and
`trace_flags`. It does not add
HTTP attributes; the HTTP middleware supplies those.

## Traces

### Spans

| Span name                                                                                                                               | Kind     | Parent                             | Attributes                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `POST /api/v1/orders/verify`, `POST /api/v1/orders` (`METHOD` alone when no route matched; `HTTP` for an unknown method) | SERVER   | remote `traceparent`, or none      | `http.request.method` (`_OTHER` + `http.request.method_original` when unknown), `url.scheme`, `url.path`, `http.route` (when matched), `http.response.status_code`, `error.type` (5xx) |
| `VerifyOrder`                                                                                                                           | INTERNAL | SERVER                             | `scos.estimate.valid`, `scos.estimate.reason` when invalid                                                                                                                             |
| `InventoryReader.readInventorySnapshot`                                                                                                 | INTERNAL | `VerifyOrder`                      | `scos.inventory.warehouse_count`                                                                                                                                                       |
| `SubmitOrder`                                                                                                                           | INTERNAL | SERVER                             | `scos.submission.outcome`, `scos.submission.replayed`, `scos.submission.rejection_reason` when rejected, `error.type` when failed                                                      |
| `SubmissionStore.findOrderBySubmissionKey`                                                                                              | INTERNAL | `SubmitOrder`                      | `scos.submission.order_found`                                                                                                                                                          |
| `SubmissionStore.runInTransaction`                                                                                                      | INTERNAL | `SubmitOrder`                      | One span per transaction attempt                                                                                                                                                       |
| `SubmissionTransaction.lockInventory`                                                                                                   | INTERNAL | `SubmissionStore.runInTransaction` | `scos.inventory.warehouse_count`                                                                                                                                                       |
| `SubmissionTransaction.findOrderBySubmissionKey`                                                                                        | INTERNAL | `SubmissionStore.runInTransaction` | `scos.submission.order_found`                                                                                                                                                          |
| `SubmissionTransaction.saveAcceptedOrder`                                                                                               | INTERNAL | `SubmissionStore.runInTransaction` |                                                                                                                                                                                        |

- **One SERVER span per request.** The middleware wraps the composed app
  once, in `composeOverDatabase` / `composeHealthApplication`
  (`withHttpTelemetry`). The endpoint app factories and `createApp` never
  add it, so the combined app (all three endpoints mounted) and each
  standalone endpoint app both produce exactly one SERVER span. Tests assert
  this for both shapes.
- **No duplicate spans.** The only automatic instrumentation is
  `PinoInstrumentation`, and it creates no spans. HTTP, `pg`, Prisma and
  `undici` auto-instrumentation are deliberately not enabled.
- **Propagation.** W3C `traceparent`/`tracestate` are extracted with the
  standard `W3CTraceContextPropagator`. An invalid header (malformed, all-zero
  IDs, version `ff`) is ignored and the request starts a new root trace.
- **Context.** `AsyncLocalStorageContextManager` carries the active span
  through each request's async work. Tests prove that concurrent requests
  never see each other's context.
- **Status.** Server spans are `ERROR` only for 5xx responses, with
  `error.type` set to the exception class or the status code (`"503"`).
  4xx responses, including business rejections (422), conflicts (409) and
  invalid input (400), leave the status unset. On INTERNAL spans, a thrown
  error sets `ERROR`; a returned business outcome (an invalid estimate, a
  rejection or a conflict) does not. `SubmitOrder` returning `unavailable`
  (503 after the retry bound) is a system failure and sets `ERROR` with
  `error.type=unavailable`.
- **Sanitized failures.** A failed span gets `error.type` and an
  `exception` event with only `exception.type` and, for database errors,
  `scos.error.code`. When the PostgreSQL SQLSTATE is known, the span also
  gets `db.response.status_code`, and `scos.error.code` is that SQLSTATE.
  The SQLSTATE comes from Prisma's `meta` (`meta.code` or
  `meta.driverAdapterError.cause.originalCode`, as inside the `P2010`
  raw-query error, so a lock timeout reports `55P03`) or from a pg
  `DatabaseError` (recognised by its `severity`). Otherwise `scos.error.code`
  is the error's own safe code, such as a Prisma code or a Node errno
  (`EPIPE`), and `db.response.status_code` is absent.
  Never `exception.message` or `exception.stacktrace`.

### Sampling

The sampler is `ParentBased(TraceIdRatioBased(OTEL_TRACES_SAMPLER_ARG))`:

- A request with a `traceparent` follows the caller's sampled flag.
- A new root trace is sampled with probability `OTEL_TRACES_SAMPLER_ARG`
  (default `1`).
- Unsampled requests still get a valid, non-recording span context, so their
  logs carry `trace_id`/`span_id` with `trace_flags: "00"`, but no span is
  exported. Metrics are recorded for every request, whatever the sampling.

## Metrics

| Name                           | Instrument | Unit           | Attributes                                                                                                                 |
| ------------------------------ | ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `http.server.request.duration` | Histogram  | `s`            | `http.request.method`, `url.scheme`, `http.response.status_code`, `http.route` (when matched), `error.type` (5xx)          |
| `scos.order.submissions`       | Counter    | `{submission}` | `scos.submission.outcome`, `scos.submission.replayed`, `scos.submission.rejection_reason` (rejected), `error.type` (error) |

- `http.server.request.duration` follows the stable HTTP semantic
  conventions, with the advised bucket boundaries (in seconds):
  `0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10`.
  Its count is the request count, so `rate(count)` is the request rate.
- `scos.order.submissions` counts **completed submission requests**: every
  call of the `SubmitOrder` use case that returns an outcome or throws. That
  is exactly one increment per `POST /api/v1/orders` that passed HTTP
  validation, whatever the result:

  | `scos.submission.outcome` | HTTP | `replayed`                                   |
  | ------------------------- | ---- | -------------------------------------------- |
  | `accepted`                | 201  | `false` for a new Order, `true` for a replay |
  | `rejected`                | 422  | `false`; plus `rejection_reason`             |
  | `conflict`                | 409  | `false`                                      |
  | `invalid`                 | 400  | `false` (the use case's own input guard)     |
  | `unavailable`             | 503  | `false`                                      |
  | `error`                   | 500  | `false`; plus `error.type` (exception class) |

  Retries inside the use case count once. Requests rejected by the HTTP
  validator (400 before the use case runs) are not counted; they appear in
  `http.server.request.duration` with status 400. The counter is not a count
  of new Orders: that is `outcome=accepted, replayed=false`.

- **Bounded dimensions.** Metric attributes are only the enumerations
  above, route templates (never raw paths), and exception class names. No
  order, submission, request or trace IDs, URLs, coordinates, messages or SQL.
  Temporality is cumulative, set explicitly on the OTLP exporter.

## Sensitive data policy

No signal contains request or response bodies, credentials, tokens,
connection strings, SQL or its parameters, customer coordinates, submission
IDs or order numbers. Enforcement:

- Spans and metrics use only the attributes listed above. `url.path` is on
  SERVER spans and the request log only (never a metric label), without the
  query string.
- Errors are reduced to their class name and a safe code; messages and
  stacks are never recorded on spans.
- Logs are redacted (see above), and SDK diagnostics are reduced to one line
  without stack frames, URLs or network addresses.
- Tests assert, per signal, that a request's submission ID, coordinates and
  order number appear nowhere: in the unit tests (`telemetry/http.test.ts`,
  `telemetry/decorators/*.test.ts`) and against the real database
  (`test/telemetry.integration.test.ts`).
- Configuration errors name the variable and a reason, never its value.
  OTLP endpoints with credentials in the URL are rejected; use
  `OTEL_EXPORTER_OTLP_HEADERS` for collector credentials.

## Configuration

Every runtime (the local server, and the health, verify and submit
configurations) validates these variables with Zod at bootstrap
(`telemetry/config.ts`). They are passed to the SDK explicitly (endpoint,
timeout, sampler, resource, intervals and metric temporality), and explicit
options take precedence over the environment. The OTLP exporters still read
the settings this schema does not cover from the environment themselves:
`OTEL_EXPORTER_OTLP_HEADERS` (use it for collector credentials),
`*_COMPRESSION`, `*_CERTIFICATE`, `*_CLIENT_CERTIFICATE` and `*_CLIENT_KEY`,
including their `_TRACES_`/`_METRICS_` variants. Invalid values stop startup with
`NAME: reason` lines; no value is ever printed. Rules for an endpoint apply
only when an OTLP exporter uses it.

| Variable                              | Default                    | Rule                                                                                                                    |
| ------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                   | `false`                    | `true` or `false`. `true`: no SDK, no spans or metrics, no correlation; JSON logs still written; endpoint rules skipped |
| `OTEL_SERVICE_NAME`                   | `scos-api`                 | 1-128 of `A-Za-z0-9._-`, starting alphanumeric. `service.name` on every signal                                          |
| `SERVICE_VERSION`                     | `@scos/api` version        | Same rule. `service.version`; set it to the release or commit                                                           |
| `DEPLOYMENT_ENVIRONMENT`              | `local`                    | Same rule. `deployment.environment.name`                                                                                |
| `LOG_LEVEL`                           | `info`                     | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`                                                            |
| `OTEL_TRACES_EXPORTER`                | `none`                     | `otlp`, `console` or `none`. With `none`, spans are still created, so logs stay correlated                              |
| `OTEL_METRICS_EXPORTER`               | `none`                     | `otlp`, `console` or `none`                                                                                             |
| `OTEL_TRACES_SAMPLER`                 | `parentbased_traceidratio` | Only this value                                                                                                         |
| `OTEL_TRACES_SAMPLER_ARG`             | `1`                        | Decimal 0 to 1, at most 6 fractional digits                                                                             |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | `http/protobuf`            | Only this value (`grpc` and `http/json` are not bundled)                                                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | `http://localhost:4318`    | Base URL; `/v1/traces` and `/v1/metrics` are appended. `http(s)://` with a host, no credentials                         |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | from the base              | Full URL used as-is; overrides the base for traces                                                                      |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | from the base              | Full URL used as-is; overrides the base for metrics                                                                     |
| `OTEL_EXPORTER_OTLP_TIMEOUT`          | `10000`                    | Milliseconds, 1-3600000. Per OTLP request, and the batch span processor's export timeout                                |
| `OTEL_METRIC_EXPORT_INTERVAL`         | `60000`                    | Milliseconds, 1-3600000                                                                                                 |
| `OTEL_METRIC_EXPORT_TIMEOUT`          | `30000`                    | Milliseconds, 1-3600000; not above the interval when metrics are exported                                               |

Fixed bounds (in code, `telemetry/node/sdk.ts`):

- `BatchSpanProcessor`: queue of 2048 spans (spans beyond it are dropped),
  batches of 512, scheduled every 1000 ms, each export bounded by
  `OTEL_EXPORTER_OTLP_TIMEOUT`.
- Span limits: 128 attributes, 128 events, attribute values of at most 1024
  characters.
- `forceFlush` and `shutdown` are bounded (5 s by default and at server
  shutdown), and they never reject.

## Export failure behaviour

- Spans end synchronously when an operation settles and are queued. Export
  happens later, in the background, never on the response path, and never
  inside the submission transaction: no decorator awaits anything but the
  wrapped call.
- An unreachable, slow or failing collector does not change any HTTP
  status, body or business outcome, and holds no database lock. Tests cover
  a refused port and a collector that accepts TCP but never answers, in unit
  tests and against the real database (five consecutive submissions under a
  500 ms lock timeout still succeed).
- Failed exports are reported as `warn` records with
  `msg: "OpenTelemetry SDK diagnostic"`, summarized and never correlated
  with a request. Captured from
  the built server with the collector down (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1`):

  ```json
  {"level":"warn","severity_number":13,"time":"2026-09-19T10:20:08.414Z","service.name":"scos-api","service.version":"0.0.0","deployment.environment.name":"local","diagnostic":"connect ECONNREFUSED [address]","msg":"OpenTelemetry SDK diagnostic"}
  {"level":"warn","severity_number":13,"time":"2026-09-19T10:20:08.710Z","service.name":"scos-api","service.version":"0.0.0","deployment.environment.name":"local","diagnostic":"PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED [address])","msg":"OpenTelemetry SDK diagnostic"}
  ```

  Both submissions in that run returned `201`, and SIGTERM exited 0.

- A full queue drops spans rather than blocking or growing memory.
- All request-time telemetry work in the HTTP middleware is guarded. If
  starting the span fails, the request runs uninstrumented. When the request
  ends, the span is ended and the duration recorded before the request log
  is written, and an error in any of these steps (a failing log sink, meter or
  tracer) is swallowed. The response is never changed. Tests cover a throwing
  logger, meter and tracer.

## Initialization, graceful shutdown and Lambda lifecycle

### Node server (`src/entrypoints/node.ts`)

1. Validate the whole environment. On failure, print sanitized errors and
   exit 1, before any telemetry, logger, database client or listener exists.
2. `startTelemetry(config.telemetry)` registers the context manager, the W3C
   propagator, the global providers and `PinoInstrumentation`, and only then
   creates the Pino logger. Pino is loaded with `createRequire` on first use,
   after the require hook is in place.
3. Compose the app with that logger and `Telemetry`, then listen.
4. On SIGINT/SIGTERM: close the listener (in-flight requests finish),
   disconnect Prisma and end the pool, then `shutdown(5000)` flushes and stops
   both providers. Flushing comes last, so the spans of requests that finished
   during the close are exported.

`startTelemetry` is idempotent: a second call returns the running runtime.

### Runtime artifact: Pino is external

The bundle contains everything except Pino (and `pg-native`). What keeps
Pino out is how it is loaded: `telemetry/node/pino-logger.ts` calls
`createRequire(import.meta.url)("pino")`, which esbuild does not follow, so
Pino is resolved from `node_modules` at runtime through Node's `require`,
after `PinoInstrumentation` has hooked it. A copy bundled by esbuild would
bypass that hook and lose correlation. The `"pino"` entry in `build.mjs`'s
`external` list is only a backstop in case Pino is ever imported statically;
today the output is identical without it.

So **the runtime artifact must contain `node_modules/pino` and its
dependencies next to `dist/`**. Without it, `node dist/node.js` fails at
startup with `Cannot find module 'pino'` (verified).

`src/entrypoints/node.bundle.test.ts` runs the built bundle on every `pnpm test` and
fails if the request log stops carrying the incoming `traceparent`'s trace
ID, that is, if Pino in the bundled load path is no longer patched by
`PinoInstrumentation` (for example because Pino was loaded before
registration or inlined into the bundle).

For #14, package `dist/` together with production `node_modules` (for
example `pnpm --filter @scos/api deploy --prod <dir>`; not yet verified), or
install `pino@10.3.1` into the artifact.

### Lambda (#14/#15)

A Lambda handler does not exist yet. Requirements for it:

- **Init once per execution environment.** Call `startTelemetry` in module
  scope (the init phase), before the first logger. Warm invocations reuse
  the providers, logger and pool; `startTelemetry` returns the same runtime
  if called again.
- **Flush at the end of every invocation, bounded.** Call
  `await runtime.forceFlush(timeoutMs)` after the response is produced and
  before returning. Lambda freezes the environment between invocations and
  may never run process shutdown, so do not rely on SIGTERM or `beforeExit`.
  Choose a bound well inside the function timeout (for example 1-2 s).
  Buffered telemetry is exported then, not during request handling, and never
  inside a transaction.
- **Periodic metrics on Lambda.** The periodic reader's timer does not run
  while the environment is frozen. The per-invocation `forceFlush` is what
  exports metrics. Set `OTEL_METRIC_EXPORT_INTERVAL` long (the default 60 s is
  fine) so exports rarely overlap with a flush.
- **Avoid duplicate exports.** Use one export path per signal. If the ADOT
  Lambda layer or an extension-hosted Collector is used, point
  `OTEL_EXPORTER_OTLP_ENDPOINT` at it (`http://localhost:4318`) and do not
  enable the layer's own auto-instrumentation (`AWS_LAMBDA_EXEC_WRAPPER`),
  which would add a second set of HTTP and database spans. Metric temporality
  is cumulative: each execution environment is its own series, so the
  backend must aggregate across instances. Delta temporality is an option for
  #15 if the backend prefers it.
- **Shutdown.** Lambda may send `SIGTERM` before shutting an environment
  down (only when an extension is registered). If #14 handles it, call
  `runtime.shutdown(timeoutMs)` with a bound well below the shutdown phase
  limit, and treat it as best effort: the per-invocation flush is what
  guarantees delivery.

## Local verification

### Console exporters

```sh
export DATABASE_URL=postgresql://scos:scos@localhost:5432/scos
pnpm --filter @scos/api build
OTEL_TRACES_EXPORTER=console OTEL_METRICS_EXPORTER=console \
  OTEL_METRIC_EXPORT_INTERVAL=10000 OTEL_METRIC_EXPORT_TIMEOUT=5000 \
  node apps/api/dist/node.js
```

Console exporters print Node object dumps to stdout, interleaved with the
JSON log lines. Use them only locally; a log collector expects JSON only.

### Local OpenTelemetry Collector (test sink)

Run a Collector with the `debug` exporter and point the API at it:

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
```

```sh
# Pin a specific Collector release tag in place of <version>.
docker run --rm -p 4318:4318 \
  -v "$PWD/otel-collector.yaml:/etc/otelcol-contrib/config.yaml" \
  otel/opentelemetry-collector-contrib:<version>

OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  node apps/api/dist/node.js
```

The Collector prints each received span and metric. The Collector setup
was not run in this change. The OTLP export path
was verified against a minimal local HTTP sink on port 14318, which
received `POST /v1/traces` and `POST /v1/metrics` with
`application/x-protobuf` bodies from `dist/node.js`.

### Automated tests

| What                                                                                                                                                                  | Where                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Logger port contract (see [Port contract tests](#port-contract-tests)) for Pino and the console JSON logger                                                           | `src/telemetry/node/pino-logger.test.ts`, `src/http/logger.test.ts` |
| Telemetry port contract over the Node SDK with in-memory exporters, including the Node compositions                                                                   | `src/telemetry/node/telemetry-contract.test.ts`                     |
| Pino specifics: newline-terminated writes, defaults, identical records from Pino and the console logger for the same calls                                            | `src/telemetry/node/pino-logger.test.ts`                            |
| Console logger specifics: no trailing newline, defaults, `defaultLogger` through `console.log`                                                                        | `src/http/logger.test.ts`                                           |
| Log contract helpers: severity constants, redaction, sanitized errors and SQLSTATEs, correlation fields, resource fields                                              | `src/telemetry/log-record.test.ts`                                  |
| Configuration: valid, invalid, conditional, sanitized messages                                                                                                        | `src/telemetry/config.test.ts`                                      |
| `startTelemetry` init-once and registration, correlation through the started runtime, resource across signals, sampling, bounded flush, exporter failure, diagnostics | `src/telemetry/node/sdk.test.ts`                                    |
| Middleware specifics: the request log, compositions without telemetry, a failing logger, tracer or meter never changes a response                                     | `src/telemetry/http.test.ts`                                        |
| Decorator specifics: invalid estimates, sanitized database and errno failures, retries and `unavailable`, unexpected errors                                           | `src/telemetry/decorators/*.test.ts`                                |
| Persistence spans against PostgreSQL, a real lock timeout, a silent collector and locks                                                                               | `test/telemetry.integration.test.ts`                                |
| No runtime-specific imports in neutral modules                                                                                                                        | `src/runtime-boundary.test.ts`                                      |
| The built `dist/node.js` still correlates logs (PinoInstrumentation on the bundled load path)                                                                         | `src/entrypoints/node.bundle.test.ts`                               |

### Port contract tests

Each telemetry port comes with a contract test suite, so that adapters stay
interchangeable. An implementation runs the whole suite with one call. The
suites live in `src/testing/` beside the other test support.

**Logger port**: `describeLoggerContract(name, createHarness)` in
`src/testing/logger-contract.test-support.ts`. The factory is called once,
before any test. It registers whatever the runtime's composition registers
for logging: the context manager that `context.with` uses, and for Pino,
`registerLogCorrelation()` before Pino is first loaded. It returns
`create({ level, base })`, which gives `{ logger, writes() }`, where
`writes()` returns every raw write. The suite checks the
[log record contract](#log-record-contract):

- one record per call, each a single JSON line;
- the exact field names, and severity text and number for every level;
- level filtering and `silent`;
- the resource fields on every record, children included;
- child bindings, including nested children;
- the redaction paths, in details and bindings;
- errors reduced to type, safe code (and SQLSTATE) and stack frames, never
  the message;
- reserved keys moved to `detail.*`, never overriding the real values;
- `trace_id`/`span_id`/`trace_flags` present only inside a valid span and
  matching it (`00` when unsampled), and absent with no span or an invalid
  one.

**Telemetry port**: `describeTelemetryContract(name, createHarness)` in
`src/testing/telemetry-contract.test-support.ts`. The factory is called
before every test and returns the runtime's `Telemetry` port backed by test
exporters, with `spans()`, `metrics()`, `flush()` and `shutdown()`. It must also return the runtime's own `compositions` (combined and
health), because a composition is where a request could get wrapped twice.
`spans()` and `metrics()` return the OpenTelemetry JS SDK shapes
(`ReadableSpan` and `MetricData`). A runtime that records through the JS SDK
hands over in-memory exporter output directly. A Workers composition that
does not (for example Cloudflare's platform tracing) needs an adapter to
these shapes, or the harness must be narrowed to what the suite reads; the
Workers PR decides which. The
suite drives the real Hono apps, the HTTP middleware and the decorators,
using fake use cases or real use cases over in-memory ports. It checks:

- exactly one SERVER span per request in the combined app, each standalone
  app and the runtime's compositions, with responses unchanged, and a 500
  logged exactly once;
- the `METHOD /route` span name and the HTTP semantic-convention attributes;
- span status: unset for 2xx, 4xx and 422, `ERROR` for 5xx;
- W3C `traceparent`/`tracestate` honoured, invalid context ignored;
- concurrent requests never share context;
- the INTERNAL span names and parents for the use cases and ports;
- `http.server.request.duration`: name, unit `s`, buckets, attributes, and
  one count per request. The sum is checked as non-negative and below 5 s,
  not as positive, because workerd only advances timers after I/O; the
  Node tests check that a real delay is measured;
- `scos.order.submissions`: its attribute sets, with replays counted and
  400s not counted;
- no submission ID, coordinate, order number, raw URL, query string or body
  in any span or metric attribute, and span attribute keys limited to the
  documented set.

Node/Lambda runs the logger suite for `createPinoLogger` and
`createConsoleJsonLogger`, and the telemetry suite over
`createTelemetryRuntime` (`telemetry/node/sdk.ts`) with in-memory exporters
and the Node compositions. The Workers composition (follow-up PR under #17)
plugs in the same way: one `describeLoggerContract` call for its
`console.log` logger, with its context manager registered in the factory,
and one `describeTelemetryContract` call over its `Telemetry` with test
exporters and its own compositions. Implementation details stay in each
runtime's own tests, for example SDK init-once, the exporters, shutdown and
Pino's require hook.

## Sample output from real API requests

Captured from the built bundle (`node apps/api/dist/node.js`) over a
migrated and seeded database, with console exporters and
`SERVICE_VERSION=0.0.0-issue17`. Requests: health; a verification with
`traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` and
`tracestate: vendor=opaque`; an accepted submission; its replay; a shipping
rejection; a conflicting reuse; an invalid body with an all-zero
`traceparent`; an unknown path. The full stdout contained no submission ID,
coordinate, order number or database credential.

### Logs (stdout)

```json
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:15.156Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","server.port":3917,"msg":"SCOS API listening on http://localhost:3917"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.563Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"5a05cef4c94aae135c9d759fcb24bebd","span_id":"baea8bda9af1c115","trace_flags":"01","http.request.method":"GET","url.scheme":"http","http.response.status_code":200,"http.route":"/health","url.path":"/health","http.server.request.duration":0.002515249999999924,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.669Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"034e972941900f13","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":200,"http.route":"/api/v1/orders/verify","url.path":"/api/v1/orders/verify","http.server.request.duration":0.08573370799999998,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.723Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"25397b0fa0cd9a97dc57a2b3eaea6b2c","span_id":"6c98de64ce775b7e","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":201,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.03952470900000003,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.734Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"c6d9200606554bba559b932ad92da915","span_id":"d8278b881d9bac68","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":201,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.002150542000000087,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.747Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"4e892305db319105782231db9209ba62","span_id":"db339a721743889b","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":422,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.005279874999999947,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.757Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"cd8b1d5b8c0957841854b0b37f98ffd7","span_id":"e3937fa583d6f463","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":409,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.0019115840000001755,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.764Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"fee99c9a381604d34ceb8b14bcce9f90","span_id":"1cc48b70af35317b","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":400,"http.route":"/api/v1/orders/verify","url.path":"/api/v1/orders/verify","http.server.request.duration":0.000462624999999889,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T10:18:16.771Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"3c7451a5cf4d02f47ec5d11be77cbaad","span_id":"67880b2f897434a4","trace_flags":"01","http.request.method":"GET","url.scheme":"http","http.response.status_code":404,"url.path":"/nope","http.server.request.duration":0.00010383299999989504,"msg":"request completed"}
```

The verification record carries the caller's trace ID `4bf92f35...` and the
SERVER span's ID `034e9729...`, shown in the spans below. The invalid
all-zero `traceparent` was ignored: that request got a new trace
(`fee99c9a...`).

### Spans (console exporter, verification trace)

```text
{
  resource: {
    attributes: {
      'service.name': 'scos-api',
      'service.version': '0.0.0-issue17',
      'deployment.environment.name': 'local'
    }
  },
  instrumentationScope: {
    name: '@scos/api',
    version: '0.0.0',
    schemaUrl: 'https://opentelemetry.io/schemas/1.43.0'
  },
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  parentSpanContext: {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
    isRemote: true,
    traceState: _TraceState { ... 'vendor' => 'opaque' ... }
  },
  traceState: 'vendor=opaque',
  name: 'POST /api/v1/orders/verify',
  id: '034e972941900f13',
  kind: 1,
  timestamp: 1789813096584000,
  duration: 85368.708,
  attributes: {
    'http.request.method': 'POST',
    'url.scheme': 'http',
    'url.path': '/api/v1/orders/verify',
    'http.response.status_code': 200,
    'http.route': '/api/v1/orders/verify'
  },
  status: { code: 0 },
  events: [],
  links: []
}
```

Its children, with the same resource, scope and trace (abridged to the
differing fields):

```text
name: 'VerifyOrder', id: '1ee7bcb8c689a933', parent spanId: '034e972941900f13', kind: 0,
  duration: 82290.583, attributes: { 'scos.estimate.valid': true }, status: { code: 0 }
name: 'InventoryReader.readInventorySnapshot', id: '436edf361dcb4530', parent spanId: '1ee7bcb8c689a933', kind: 0,
  duration: 81108.541, attributes: { 'scos.inventory.warehouse_count': 6 }, status: { code: 0 }
```

The accepted submission's trace `25397b0fa0cd9a97dc57a2b3eaea6b2c`
(abridged the same way):

```text
name: 'POST /api/v1/orders', id: '6c98de64ce775b7e', parent: none, kind: 1, duration: 39589.041,
  attributes: { 'http.request.method': 'POST', 'url.scheme': 'http', 'url.path': '/api/v1/orders',
                'http.response.status_code': 201, 'http.route': '/api/v1/orders' }
name: 'SubmitOrder', id: 'c2b24de8a3117f16', parent: '6c98de64ce775b7e', duration: 38601.542,
  attributes: { 'scos.submission.outcome': 'accepted', 'scos.submission.replayed': false }
name: 'SubmissionStore.findOrderBySubmissionKey', id: '04a83ecaeef52492', parent: 'c2b24de8a3117f16',
  duration: 10220.041, attributes: { 'scos.submission.order_found': false }
name: 'SubmissionStore.runInTransaction', id: '9a1952e082ef25ec', parent: 'c2b24de8a3117f16',
  duration: 27923.5, attributes: {}
name: 'SubmissionTransaction.lockInventory', id: '3d761e4b9d377245', parent: '9a1952e082ef25ec',
  duration: 1912.75, attributes: { 'scos.inventory.warehouse_count': 6 }
name: 'SubmissionTransaction.findOrderBySubmissionKey', id: '2fea631fedb682be', parent: '9a1952e082ef25ec',
  duration: 1040.667, attributes: { 'scos.submission.order_found': false }
name: 'SubmissionTransaction.saveAcceptedOrder', id: 'edd0a85ff18827e3', parent: '9a1952e082ef25ec',
  duration: 19986.667, attributes: {}
```

Durations are in microseconds in the console exporter's output.

### Metrics (console exporter, flushed at graceful shutdown)

```text
{
  descriptor: {
    name: 'scos.order.submissions',
    type: 'COUNTER',
    description: 'Completed order submission requests by outcome, including replays of an accepted Order. Not a count of new Orders.',
    unit: '{submission}',
    valueType: 0,
    advice: {}
  },
  dataPointType: 3,
  dataPoints: [
    { attributes: { 'scos.submission.outcome': 'accepted', 'scos.submission.replayed': false }, ..., value: 1 },
    { attributes: { 'scos.submission.outcome': 'accepted', 'scos.submission.replayed': true }, ..., value: 1 },
    { attributes: { 'scos.submission.outcome': 'rejected', 'scos.submission.replayed': false,
                    'scos.submission.rejection_reason': 'SHIPPING_EXCEEDS_LIMIT' }, ..., value: 1 },
    { attributes: { 'scos.submission.outcome': 'conflict', 'scos.submission.replayed': false }, ..., value: 1 }
  ]
}
```

`http.server.request.duration` (one of seven data points; the others are
`GET /health` 200, verify 200 and 400, submit 422 and 409, and `GET` 404
without `http.route`):

```text
{
  descriptor: {
    name: 'http.server.request.duration',
    type: 'HISTOGRAM',
    description: 'Duration of HTTP server requests.',
    unit: 's',
    valueType: 1,
    advice: { explicitBucketBoundaries: [ 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10 ] }
  },
  dataPoints: [
    {
      attributes: {
        'http.request.method': 'POST',
        'url.scheme': 'http',
        'http.response.status_code': 201,
        'http.route': '/api/v1/orders'
      },
      startTime: [ 1789813096, 723000000 ],
      endTime: [ 1789813097, 294000000 ],
      value: {
        min: 0.002150542000000087,
        max: 0.03952470900000003,
        sum: 0.04167525100000012,
        buckets: { boundaries: [ ... ], counts: [ 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
        count: 2
      }
    },
    ...
  ]
}
```

## Versions

Pinned in `apps/api/package.json`:

| Package                                      | Version                               |
| -------------------------------------------- | ------------------------------------- |
| `pino`                                       | 10.3.1                                |
| `@opentelemetry/api`                         | 1.9.1                                 |
| `@opentelemetry/sdk-trace`                   | 2.11.0                                |
| `@opentelemetry/sdk-metrics`                 | 2.11.0                                |
| `@opentelemetry/resources`                   | 2.11.0                                |
| `@opentelemetry/core`                        | 2.11.0                                |
| `@opentelemetry/context-async-hooks`         | 2.11.0                                |
| `@opentelemetry/exporter-trace-otlp-proto`   | 0.222.0                               |
| `@opentelemetry/exporter-metrics-otlp-proto` | 0.222.0                               |
| `@opentelemetry/instrumentation`             | 0.222.0                               |
| `@opentelemetry/instrumentation-pino`        | 0.68.0 (supports `pino >=5.14.0 <11`) |
| `@opentelemetry/semantic-conventions`        | 1.43.0                                |

Semantic conventions: **1.43.0**. Spans and metrics carry the scope schema
URL `https://opentelemetry.io/schemas/1.43.0`, and a unit test keeps
`SEMCONV_VERSION` equal to the pinned package.

## Limitations

- **No log export from the application.** Logs reach an OTel backend only
  through the platform or a Collector parsing stdout, by design.
- **HTTP attributes are a subset.** `server.address`, `server.port`,
  `network.protocol.version`, `user_agent.original` and `client.address` are
  not recorded.
- **Request logs record `url.path`** (never the query string). An unmatched
  path is logged and put on the span as sent; it never becomes a metric label.
- **Error codes may be Prisma codes.** When a Prisma error carries no
  SQLSTATE (for example a `P2028` transaction timeout), `scos.error.code` is
  the Prisma code and `db.response.status_code` is absent. A SQLSTATE is
  taken only from Prisma's `meta` or from an error shaped like a pg
  `DatabaseError` (it has `severity`), never from a bare `code`. A Node errno
  such as `EPIPE` therefore appears as `scos.error.code` only.
- **Unsampled traces still correlate logs** (`trace_flags: "00"`), but those
  trace IDs have no exported spans.
- **Pino must ship beside the bundle** (see "Runtime artifact").
- **Lambda handler and flush wiring** are specified here but implemented in
  #14; warm reuse and flush behaviour must be verified on AWS there (#15).
- **The Workers composition** is not implemented yet (follow-up PR under #17).
- **The Collector container recipe was not run** in this change; OTLP export
  was verified against a local HTTP sink.
- **Console exporter output is not JSON** and mixes with JSON logs on stdout;
  it is for local use only.
