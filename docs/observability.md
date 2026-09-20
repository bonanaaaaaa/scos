# Observability

SCOS emits three OpenTelemetry-aligned signals from `apps/api` (issue #17):

| Signal  | How it is produced                                                                         | Where it goes                                                         |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Logs    | Pino JSON, one line per call, on stdout; `PinoInstrumentation` adds trace correlation only | stdout, collected by the platform (CloudWatch Logs) or a Collector    |
| Traces  | Manual spans: one SERVER span per request, plus use-case and persistence-port spans        | OTLP/HTTP (protobuf) or the console, through a bounded batch exporter |
| Metrics | `http.server.request.duration` histogram and `scos.order.submissions` counter              | OTLP/HTTP (protobuf) or the console, through a periodic reader        |

That table is the Node/Lambda runtime. The Cloudflare Worker produces the
same records, spans and metrics with its own composition: logs through
`console.log` into Workers Logs, and traces and metrics exported over OTLP
with `fetch` once per request. See
[Cloudflare Workers runtime](#cloudflare-workers-runtime).

The domain and persistence packages (`packages/core`, `packages/persistence`)
have no OpenTelemetry dependency. Their ports are wrapped by decorators in
the API compositions.

![Telemetry in the SCOS hexagonal architecture](images/telemetry-hexagon.svg)

## Runtime-neutral ports and the Node/Lambda composition

Telemetry sits behind ports that do not depend on a runtime. The runtime's
composition wires them.

| Module                                   | Runtime | Contents                                                                                                                                                                                                   |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http/logger.ts`                     | neutral | `Logger` / `StructuredLogger` ports; `createConsoleJsonLogger`, the default when nothing is injected                                                                                                       |
| `src/telemetry/log-record.ts`            | neutral | The log record contract: severity mapping, redaction keys, error sanitizing, correlation fields, resource fields                                                                                           |
| `src/telemetry/telemetry.ts`             | neutral | The `Telemetry` port (tracer, propagator, histogram, counter), built from any providers                                                                                                                    |
| `src/telemetry/http.ts`                  | neutral | Hono middleware: SERVER span, HTTP attributes, duration histogram, request log                                                                                                                             |
| `src/telemetry/decorators/`              | neutral | One file per wrapped use case or port: `verify-order.ts`, `submit-order.ts` (plus the counter), `inventory-reader.ts`, `submission-store.ts` (and its transaction); `span.ts` holds the shared span helper |
| `src/telemetry/config.ts`                | neutral | Zod schema for the telemetry variables                                                                                                                                                                     |
| `src/telemetry/node/sdk.ts`              | Node    | SDK providers, exporters, AsyncLocalStorage context manager, `PinoInstrumentation`, flush and shutdown (`startTelemetry`)                                                                                  |
| `src/telemetry/node/pino-logger.ts`      | Node    | The Pino adapter, loaded after instrumentation is registered                                                                                                                                               |
| `src/telemetry/workers/sdk.ts`           | Workers | SDK providers, the per-request span buffer and DELTA metric reader, the `console.log` sink, `flush()` for `ctx.waitUntil` (`createWorkersTelemetry`)                                                       |
| `src/telemetry/workers/otlp-exporter.ts` | Workers | OTLP/HTTP protobuf export over `fetch`: one bounded request per signal per flush, no retries                                                                                                               |
| `src/telemetry/workers/context.ts`       | Workers | The `AsyncLocalStorage` context manager (`nodejs_compat`)                                                                                                                                                  |

The neutral modules import only `@opentelemetry/api`, the
semantic-convention constants, Zod, Hono and our own ports. They never read
`process.env`. `src/runtime-boundary.test.ts` enforces this. The apps, the
middleware and the decorators receive the `Telemetry` object and the logger
through their app and composition options. When no telemetry is passed,
nothing is instrumented, so pure app construction and tests need no SDK.

The Cloudflare Workers composition (`telemetry/workers/`,
`composition/worker.ts`, `entrypoints/worker.ts`) plugs into the same ports.
`runtime-boundary.test.ts` also checks, transitively from each entry point,
that nothing the Worker reaches is Node-only (`telemetry/node/`, Pino,
`@opentelemetry/context-async-hooks`, `sdk-node`, instrumentation or the
`exporter-*` packages, `@hono/node-server`) and that nothing the Node entry
point reaches is Workers-only. See
[Cloudflare Workers runtime](#cloudflare-workers-runtime).

## Log record contract

Every logger adapter (Pino on Node/Lambda, and the console JSON logger,
which the Worker uses) writes one JSON object per call, as a single line
(the Worker logs the same object to `console.log`):

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

- **Lambda (#14, deferred):** the runtime ships stdout to CloudWatch Logs. Parse
  the JSON (for example CloudWatch Logs Insights, a subscription filter, or
  the ADOT Lambda layer's Collector) and map fields with the table above.
- **Containers or local:** send container stdout to an OpenTelemetry
  Collector `filelog` receiver with a `json_parser` operator. Map `time` to
  timestamp, `level`/`severity_number` to severity, `msg` to body,
  `trace_id`/`span_id`/`trace_flags` to the trace fields, and the
  `service.*`/`deployment.*` keys to resource attributes.
- Each call is exactly one line, so line-based collectors never split or
  merge records.
- **Cloudflare Workers:** the same record, logged as an object with one
  `console.log` call, into Workers Logs and optionally Logpush. See
  [Logs and the collection path](#logs-and-the-collection-path).

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

### Lambda (#14, deferred)

The AWS Lambda deployment follows the Cloudflare one
([ADR 0005](adr/0005-cloudflare-first-deployment.md)). A Lambda handler does
not exist yet. Requirements for it:

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

| What                                                                                                                                                                                                                    | Where                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Logger port contract (see [Port contract tests](#port-contract-tests)) for Pino and the console JSON logger                                                                                                             | `src/telemetry/node/pino-logger.test.ts`, `src/http/logger.test.ts`                |
| Telemetry port contract over the Node SDK with in-memory exporters, including the Node compositions                                                                                                                     | `src/telemetry/node/telemetry-contract.test.ts`                                    |
| Pino specifics: newline-terminated writes, defaults, identical records from Pino and the console logger for the same calls                                                                                              | `src/telemetry/node/pino-logger.test.ts`                                           |
| Console logger specifics: no trailing newline, defaults, `defaultLogger` through `console.log`                                                                                                                          | `src/http/logger.test.ts`                                                          |
| Log contract helpers: severity constants, redaction, sanitized errors and SQLSTATEs, correlation fields, resource fields                                                                                                | `src/telemetry/log-record.test.ts`                                                 |
| Configuration: valid, invalid, conditional, sanitized messages                                                                                                                                                          | `src/telemetry/config.test.ts`                                                     |
| `startTelemetry` init-once and registration, correlation through the started runtime, resource across signals, sampling, bounded flush, exporter failure, diagnostics                                                   | `src/telemetry/node/sdk.test.ts`                                                   |
| Middleware specifics: the request log, compositions without telemetry, a failing logger, tracer or meter never changes a response                                                                                       | `src/telemetry/http.test.ts`                                                       |
| Decorator specifics: invalid estimates, sanitized database and errno failures, retries and `unavailable`, unexpected errors                                                                                             | `src/telemetry/decorators/*.test.ts`                                               |
| Persistence spans against PostgreSQL, a real lock timeout, a silent collector and locks                                                                                                                                 | `test/telemetry.integration.test.ts`                                               |
| No runtime-specific imports in neutral modules                                                                                                                                                                          | `src/runtime-boundary.test.ts`                                                     |
| The built `dist/node.js` still correlates logs (PinoInstrumentation on the bundled load path)                                                                                                                           | `src/entrypoints/node.bundle.test.ts`                                              |
| Workers: both port contract suites inside workerd, the OTLP `fetch` export, DELTA metric values, exporter failure, the span buffer, sampling, the `console.log` sink                                                    | `src/telemetry/workers/*.workers.test.ts` (`pnpm test:workers`)                    |
| Workers: the `fetch` handler (config once per isolate, `waitUntil` flush, concurrent context) and the composition                                                                                                       | `src/entrypoints/worker.workers.test.ts`, `src/composition/worker.workers.test.ts` |
| Workers: the Wrangler bundle (no Node-only telemetry, Prisma edge runtime, size)                                                                                                                                        | `src/entrypoints/worker.bundle.test.ts`                                            |
| Workers against PostgreSQL through Hyperdrive: every endpoint, spans, metrics, logs, concurrent submissions, a collector that is down                                                                                   | `test/workers/worker.workers.integration.test.ts` (`pnpm test:integration`)        |
| The served API end to end: W3C continuation, span and log correlation, concurrent-request isolation, the submission counter, the request-duration histogram, no request data or connection details, an unexpected error | `apps/api-acceptance/test/telemetry.acceptance.test.ts` (`pnpm test:integration`)  |

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
and the Node compositions. The Workers runtime runs both suites inside
workerd (`@cloudflare/vitest-pool-workers`): the logger suite for the console
JSON logger with the Workers `console.log` sink and the Workers context
manager, and the telemetry suite over `createWorkersTelemetry` with in-memory
exporters in place of the `fetch` exporters and the Worker composition
(`composeWorkerApplication`) plus the health composition. Both runtimes record
through the JS SDK, so the harness hands over `ReadableSpan` and `MetricData`
directly; the Workers harness adds up its DELTA per-request exports into the
cumulative view `metrics()` returns. Implementation details stay in each
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

## Cloudflare Workers runtime

`apps/api` also runs as a Cloudflare Worker (`wrangler.jsonc`,
`src/entrypoints/worker.ts`). The Worker serves the same `createApp` (all
three endpoints and the documentation routes) over the same use cases,
persistence adapters, middleware and decorators. It emits the same log
records, spans, metrics, attributes and resource, with the same redaction
and bounded dimensions. Only the composition differs. This section covers
what #17 owns: the runtime, telemetry and local verification. The
Hyperdrive and PlanetScale design is #28's
([Cloudflare deployment design](cloudflare-deployment-design.md));
provisioning and deployment belong to #15, and hosted checks to #33.

| Module                                   | Contents                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/entrypoints/worker.ts`              | The `fetch` handler: validates `env` once per isolate, builds telemetry and the composition, hands the flush to `ctx.waitUntil` |
| `src/composition/worker.ts`              | `composeWorkerApplication`: `createApp` with a per-request database (pool and Prisma client over Hyperdrive)                    |
| `src/telemetry/workers/sdk.ts`           | `createWorkersTelemetry`: tracer and meter providers, span buffer, DELTA reader, `console.log` sink, `flush()`                  |
| `src/telemetry/workers/otlp-exporter.ts` | OTLP/HTTP protobuf over `fetch`, serialized by `@opentelemetry/otlp-transformer`                                                |
| `src/telemetry/workers/context.ts`       | `AsyncLocalStorage` context manager                                                                                             |
| `wrangler.jsonc`                         | `nodejs_compat`, pinned `compatibility_date`, the `HYPERDRIVE` binding, `observability`, non-secret `vars`                      |

### Approach and why

Tracing and metrics use the **OpenTelemetry JS SDK inside the Worker**
(`TracerProvider` from `@opentelemetry/sdk-trace`, `MeterProvider` from
`@opentelemetry/sdk-metrics`, the W3C propagator), wired into the unchanged
runtime-neutral `Telemetry` port. Export is OTLP/HTTP protobuf over `fetch`,
once per request, handed to `ctx.waitUntil`.

- **Not Cloudflare's automatic Workers tracing.** It traces the platform's
  view (the handler invocation, `fetch` subrequests, bindings). It does not
  produce our use-case and persistence spans, our span names, status rules
  (4xx unset, 5xx error) or sanitized `exception` events, and it records no
  `http.server.request.duration` or `scos.order.submissions`. Running it
  beside our spans would add a second SERVER-like span per request and a span
  for every OTLP export. So exactly one tracer records each request: while
  the application exports no traces (`OTEL_TRACES_EXPORTER` is `none`, the
  default until an OTLP backend is chosen), Cloudflare's automatic tracing is
  on (`observability.traces.enabled: true` in `wrangler.jsonc`), so the
  deployed Worker is traced at all; once OTLP trace export is on, the
  deploy's generated configuration
  (`infra/cloudflare/scripts/worker-deploy-config.mjs`) turns Cloudflare's
  tracing off. Set in the committed file, not the dashboard: `wrangler deploy`
  applies the file's setting on every deploy.
  - OTLP export with no endpoint fails the deploy configuration: the SDK would
    fall back to `localhost`, unreachable from a deployed Worker, and drop
    every span while Cloudflare's tracing is off. `OTEL_TRACES_SAMPLER_ARG=0`
    with OTLP also records nothing; that is an explicit choice.
  - With `OTEL_TRACES_EXPORTER=console` the application's spans are log lines
    in Workers Logs, so Cloudflare's tracing deliberately stays on beside
    them; they do not collide in a trace backend.
  - Cloudflare's tracing counts toward Workers Observability events (checked
    2026-09-20: free during the beta; from 1 October 2026 the Free plan
    includes 200,000 events a day with 3 days' retention, Paid 20 million a
    month with 7 days). `head_sampling_rate` defaults to 1, every request;
    set it in `wrangler.jsonc` if the volume matters. Exporting these traces
    to an OTLP destination is Paid only
    ([Cloudflare docs](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)).
- **Not `@microlabs/otel-cf-workers`.** It wraps the handler and globals
  (`fetch`, bindings) to create its own spans, brings its own SDK setup,
  exporter and flush, and would duplicate our SERVER span and add spans for
  our own exports. It also records no metrics. Our middleware and decorators
  already produce every span we want; what the Worker needed was only
  providers, a context manager and an exporter that fit the runtime, which
  are a few small modules here.
- **Same SDK as Node, so the same contract.** Both runtimes hand
  `ReadableSpan`/`MetricData` to the shared contract suites, and the
  attribute and naming code is shared, not re-implemented.
- **No Node composition pieces.** `NodeSDK`, `PinoInstrumentation` (a
  `require` hook), `@opentelemetry/context-async-hooks`, the periodic metric
  reader and the Node OTLP exporters (Node `http`) are not used. The
  `@opentelemetry/exporter-*-otlp-proto` browser builds use `fetch` but with
  browser-only options (`keepalive`, `mode`) and a retrying transport with
  backoff timers, which do not fit a per-request export, so
  `otlp-exporter.ts` serializes with the SDK's own
  `@opentelemetry/otlp-transformer` and posts once.

### Context

`WorkersContextManager` (`telemetry/workers/context.ts`) is a
`ContextManager` over `AsyncLocalStorage` from `node:async_hooks`, which
workerd provides with `nodejs_compat`. It is registered once per isolate.
Each request's active span follows its own async chain, so concurrent
requests in one isolate never see each other's context. Tests prove it inside
workerd: the contract suite's concurrent-requests test, and twelve concurrent
requests through the real `fetch` handler whose request logs each carry their
own `traceparent`'s trace ID and their own path
(`entrypoints/worker.workers.test.ts`).

### Logs and the collection path

The Worker's logger is the runtime-neutral `createConsoleJsonLogger`, so the
[log record contract](#log-record-contract) is identical to Pino's: the same
fields and severity mapping, the same redaction and error sanitizing, the
same reserved keys, and `trace_id`/`span_id`/`trace_flags` only from a valid
active span (the logger contract suite runs inside workerd). Its sink,
`logRecord`, logs **the record object**, one `console.log` call per record.
No Pino, no OTel Logs SDK, no log export from the application.

- **Workers Logs** (`observability.logs.enabled: true`) stores each
  `console.log` call as one event. It extracts and indexes the fields of a
  logged object, which is why the sink logs the object and not a JSON string:
  a string is kept as one opaque message. Verified locally in `wrangler dev`'s
  observability store: the string form was stored as `["{\"level\":...}"]`,
  the object form as `[{"level":"info",...}]`.
- **Logpush** (Workers Trace Events, Paid plan) ships the same events, with
  each record in `Logs[].Message`, to R2, S3 or a log vendor; a Collector or
  pipeline there maps them with the table below. Cloudflare's OTLP log export
  or a Tail Worker are alternatives for #15 to choose.
- **Mapping.** Exactly the [LogRecord mapping](#mapping-to-the-otel-logrecord-model):
  `time` to Timestamp, `level`/`severity_number` to SeverityText/Number,
  `msg` to Body, `trace_id`/`span_id`/`trace_flags` to the trace fields,
  `service.*`/`deployment.environment.name` to the Resource, everything else
  to Attributes. Workers Logs adds its own invocation metadata (the request,
  outcome, CPU and wall time) beside the record.
- One `console.log` per record, so a record is never split or merged.
- Export failures and invalid configuration are the only other logs:
  `warn` `OpenTelemetry export failed` with `scos.telemetry.signal` and a
  `diagnostic` of `HTTP <status>`, `timeout` or an error class name (never the
  endpoint, headers or response), and `console.error` lines naming invalid
  variables (never their values).

### Metrics and accuracy

There is no long-lived process and no timer between requests, so there is no
periodic reader. `RequestMetricReader` is a pull reader with **DELTA**
temporality, collected on every flush: each flush exports what was recorded
in this isolate since the previous flush, and nothing when nothing was
recorded. Every recording is exported exactly once (unless its export
fails), whichever concurrent request's flush carries it.

- **Why DELTA.** Isolates are many, short-lived and evicted without notice.
  Cumulative series per isolate would each restart at zero, and a backend
  would see many overlapping, resetting series; per-request deltas add up
  without that. A backend that only accepts cumulative data needs the
  Collector's `deltatocumulative` processor. Node/Lambda stays cumulative.
- **Cardinality.** The attributes are exactly the Node ones (method, route
  template, status, bounded outcomes). No isolate or request identifier is
  added, so DELTA points from all isolates of one version aggregate into the
  same series.
- **Accuracy loss.**
  - workerd advances `Date.now()` and `performance.now()` only on I/O (a
    Spectre mitigation). `http.server.request.duration` and span durations
    therefore measure time spent waiting on I/O (database, Hyperdrive), at
    millisecond resolution; CPU-only work such as `GET /health` measures `0`.
    Log `time` values have the same resolution. Use Workers Logs' CPU and
    wall time for compute cost.
  - A DELTA point's start and end times are often equal for the same reason.
  - A failed export loses that flush's metrics (no retry) and its spans.
  - Up to the response, recordings are in memory; an isolate evicted before a
    flush completes loses them. The flush runs right after each response.

### Flush, limits and subrequests

- **Per request:** after `app.fetch` returns, the handler calls
  `ctx.waitUntil(runtime.flush())`. The flush is never awaited on the
  response path, and it starts after the request's database work has
  finished (the transaction is committed or rolled back, the request's pool
  is being closed under its own `waitUntil`), so it can never hold a lock or
  extend a transaction. Decorators await nothing but the wrapped call.
- **Bounded:** one flush exports at most one span batch
  (`maxExportBatchSize` 512) and one metrics collection. Each OTLP request is
  bounded by `OTEL_EXPORTER_OTLP_TIMEOUT` (default 3 s, at most 30 s, the
  `waitUntil` allowance) through an `AbortSignal`, and the whole flush by
  that plus 250 ms. It never rejects. The span buffer holds at most 2048
  spans; beyond that, spans are dropped (`droppedSpans()`), never queued
  without bound. A request produces at most 15 spans (a submission with
  three transaction attempts).
- **No retries:** a failed export is dropped and logged once per signal. A
  down or slow collector therefore costs the same as a healthy one, and it
  cannot change a status, a body or an outcome. Tests cover a refused
  connection, a 503, a collector that never answers (the timeout) and a real
  unreachable address, in unit tests and against PostgreSQL (five
  submissions in a row, each under 5 s, with the collector down).
- **Subrequests per request:** at most **2** (one `POST /v1/traces`, one
  `POST /v1/metrics`), and fewer when there is nothing to send: an unsampled
  request sends no spans, and another request's flush may already have
  exported its data. With exporters `none` it is **0**; with `console` it is
  0 (printed to the Workers console). The limits are 50 subrequests per
  request on Workers Free and 10,000 on Paid. The database connection to
  Hyperdrive is a socket, one of the six simultaneous connections a request
  may open (the pool allows two); the OTLP requests are two more at most.
  Measured locally: every request produced exactly one traces and one metrics
  POST at the Collector (18 exports for 9 requests).
- **CPU:** serializing a few spans and two metrics is well under a
  millisecond. The Free plan's 10 ms CPU limit per request is more likely to
  be reached by Prisma (see below) than by telemetry.

### Database: Prisma 7 over Hyperdrive

- **Per-request pool and Prisma client.** As #28 specifies and as
  Cloudflare's Hyperdrive connection-lifecycle guidance requires, the
  database client is created inside the request handler, per request, and
  released when the request ends. Workers do not allow an I/O object (a
  socket) created for one request to be used by another; Hyperdrive keeps
  the pooled connections to the origin, so connecting to it is cheap. Each
  request that reaches a use case gets its own Prisma client over its own pg
  **`Pool` of at most 2 connections** (a `Pool`, not a single `Client`,
  because `@prisma/adapter-pg` takes a pool; a request's queries are
  sequential, so it opens one connection and the second is headroom, well
  under Workers' six simultaneous connections per request), on the
  Hyperdrive binding's connection string. Both are created on first use and
  released under `ctx.waitUntil` after the response (Prisma disconnected,
  then the pool ended). `GET /health`, the docs and requests rejected by
  validation open nothing.
- **Once per isolate:** configuration validation, telemetry, the app, its
  routes and the OpenAPI document, and the use-case wiring. Never a database
  client.
- **Supporting evidence for the per-request client.** Sharing one Prisma
  client across requests is unsafe even over per-request pools: a spike with
  one isolate-wide Prisma client over a pool routed per request with
  `AsyncLocalStorage` hung under ten concurrent requests, because Prisma
  batches concurrent calls, so one request's query ran on another request's
  connection. Creating a client per request is local work (no connection
  until the first query); the query compiler is a precompiled WebAssembly
  module in the upload, which each client instantiates.
- **Prisma on workerd needs its own client build.** Prisma's Node client
  compiles the query compiler from base64 at run time, which workerd forbids
  (`WebAssembly.Module(): Wasm code generation disallowed by embedder`), and
  it reads `import.meta.url`. `packages/persistence` therefore generates a
  second client (`generator workerd`, `runtime = "workerd"` in
  `schema.prisma`) and builds the same sources over it to
  `dist/workerd/` (`tsdown.config.ts`), exported under the `workerd` package
  condition. Wrangler and `@cloudflare/vitest-pool-workers` resolve it; Node
  never does. The adapters' `Prisma.PrismaClientKnownRequestError`,
  `Prisma.Decimal` and isolation levels then come from the same runtime as
  the client, so error classification and retries behave as on Node.
- #28 settled transaction pooling, isolation, lock timeouts and the
  connection budget under Hyperdrive
  ([Cloudflare deployment design](cloudflare-deployment-design.md)), with a
  simulated pooler against local PostgreSQL; #33 measures them through a real
  Hyperdrive. Locally, `wrangler dev` connects straight
  to PostgreSQL (`localConnectionString`); the integration test runs eight
  concurrent submissions and eight concurrent verifications through one
  isolate.

### Configuration

Validated once per isolate, on the first request, by `parseWorkerConfig`
(`config.ts`, the same Zod helpers as every runtime). `DATABASE_URL` is the
Hyperdrive binding's `connectionString`; a variable named `DATABASE_URL` is
ignored. If anything is invalid, the Worker serves nothing: every request
gets `500 INTERNAL_ERROR` with the standard envelope, and the problems are
logged once as `NAME: reason` lines without values (for example
`HYPERDRIVE (binding connectionString): is required`). A failure while
building the composition is logged by error class only.

| Variable (Worker `vars` or secret)                                                                 | Default                 | Rule on Workers                                                                         |
| -------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`, `OTEL_SERVICE_NAME`, `SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT`, `LOG_LEVEL` | as on Node              | As on Node                                                                              |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`                                                    | `none`                  | `otlp`, `console` or `none`                                                             |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`                                                   | parent-based, `1`       | As on Node                                                                              |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                                                      | `http/protobuf`         | Only this value                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `..._TRACES_ENDPOINT`, `..._METRICS_ENDPOINT`                       | `http://localhost:4318` | As on Node; checked only when an exporter is `otlp`                                     |
| `OTEL_EXPORTER_OTLP_TIMEOUT`                                                                       | `3000`                  | Milliseconds, 1-30000 (the `waitUntil` allowance). Per OTLP request                     |
| `OTEL_EXPORTER_OTLP_HEADERS` (**secret**)                                                          | none                    | `name=value,name2=value2`, values URL-encoded; sent on every OTLP request. Never echoed |
| `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_TIMEOUT`                                        |                         | Not used on Workers (no periodic reader) and ignored                                    |

- Non-secret values go in `wrangler.jsonc` `vars` (traces and metrics are
  `none` there until #15 sets an endpoint per environment; #33 verifies it). Collector
  credentials are only ever a secret: `wrangler secret put
OTEL_EXPORTER_OTLP_HEADERS` when deployed, `apps/api/.dev.vars` locally
  (ignored by Git; see `apps/api/.dev.vars.example`). They never appear in
  `wrangler.jsonc`, logs or error messages. Endpoint URLs with credentials are
  rejected, as on Node.
- Unlike Node, the exporter reads nothing from the environment itself: every
  setting, headers included, comes from this validated configuration.

### Wrangler configuration and bundle

- `compatibility_date` `2026-08-15` (pinned, not later than the workerd
  release of the pinned Wrangler and pool), `compatibility_flags`
  `["nodejs_compat"]`, `send_metrics: false`.
- `hyperdrive`: binding `HYPERDRIVE` with a placeholder ID (#15's pipeline
  injects the real one from its Terraform output) and a local-only `localConnectionString` (the docker compose
  database, the same local credentials as `.env.example`). Override it with
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`.
- `observability`: Workers Logs on with invocation logs; automatic traces off.
- `alias`: `effect` points at a stub that throws if ever loaded. hono-openapi's
  unused schema adapters would otherwise bundle `effect` and `fast-check`
  (2.8 MB); `build.mjs` leaves the same modules external on Node.
- Wrangler bundles the Worker with esbuild; `build.mjs` is unchanged.
  **Measured bundle** (`wrangler deploy --dry-run`): **5,515 KiB uncompressed,
  1,538 KiB gzip**, of which 3.4 MB is Prisma's query compiler
  (`query_compiler_fast_bg.wasm`). The Workers limit is 64 MiB uncompressed
  on every plan (the compressed limits were removed on 2026-09-04); the
  bundle also fits the former 3 MB Free limit. Startup must stay under 1 s;
  nothing heavy runs at global scope (the app is built on the first request).
  `src/entrypoints/worker.bundle.test.ts` builds it on every `pnpm test` and
  fails if Pino, instrumentation, the async-hooks context manager, the
  `exporter-*` packages, `@hono/node-server`, `effect` or the Node Prisma
  runtime appear, or if the upload exceeds an 8 MiB budget.

### Tests

| Project                                 | Command                                             | Runs in                                              | Covers                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest.workers.config.mjs`             | `pnpm test:workers` (part of `pnpm test` and CI)    | workerd, no database                                 | Both contract suites; OTLP `fetch` export; DELTA values; exporter failure; span buffer; sampling; the sink; the handler; the composition                                                                                                                                            |
| `vitest.config.mjs` (Node)              | `pnpm test`                                         | Node                                                 | Workers config schema, the runtime boundary, the Wrangler bundle                                                                                                                                                                                                                    |
| `vitest.workers.integration.config.mjs` | `pnpm test:integration` (needs `DATABASE_TEST_URL`) | workerd + PostgreSQL                                 | The real handler through the `HYPERDRIVE` binding: every endpoint, persistence spans, counter values, correlated logs, no sensitive data, concurrency, a down collector                                                                                                             |
| `apps/api-acceptance/vitest.config.mjs` | `pnpm test:integration` (needs `DATABASE_TEST_URL`) | Node + PostgreSQL, the API as a served child process | The built `dist/node.js` exporting OTLP/HTTP protobuf to a fake collector in the test process, with logs read from its stdout: W3C continuation, correlation, concurrent-request isolation, the submission counter, the request-duration histogram, sanitizing, an unexpected error |

- The workerd projects use `@cloudflare/vitest-pool-workers` with the
  Worker's own `wrangler.jsonc`. `vitest.workers.shared.mjs` points pg's
  `pg-protocol` and `pg-cloudflare` at their CommonJS builds: the pool loads
  pg through a CommonJS fallback that ignores the `workerd` condition
  Wrangler's bundler uses.
- The integration project's `globalSetup` (Node) creates an isolated,
  migrated and seeded database from `DATABASE_TEST_URL`, as the Node
  integration tests do, and points the binding at it.
- The acceptance project asserts telemetry **after the server process has
  exited**: shutdown flushes the batch span processor and the periodic metric
  reader, so nothing is lost to batching and no polling is needed. It decodes
  the OTLP protobuf payloads with a small hand-written wire reader in
  `test/support/otlp/`, because that app carries no `@opentelemetry/*`
  dependency at all — it may only touch the API through the built artifact,
  HTTP and process output.
- The 80% coverage gates apply to the Node project. V8 coverage does not
  run inside workerd, so the Workers-only modules are excluded from the Node
  coverage report and covered by the workerd projects instead (not measured).
- **`Uncaught (in promise) Error: Network connection lost`.** Under
  `@cloudflare/vitest-pool-workers`, workerd prints this line (as
  `uncaught exception; source = Uncaught (in promise); ...`) once for every
  `fetch` that fails to connect, so once per signal when the collector is
  down: two per request, ten in the collector-down integration test. It is
  workerd's own log, not an unhandled rejection in our code:
  - A minimal repro with none of our code, run in the same pool, prints it
    once per call for every variant: a `GET` with no body, and a `POST` with
    a string, a `Uint8Array`, an `ArrayBuffer`, or an `ArrayBuffer` plus an
    `AbortSignal`, each awaited with a rejection handler:

    ```ts
    addEventListener("unhandledrejection", (event) => unhandled.push(event.reason));
    await fetch("http://127.0.0.1:9/x", { method: "POST", body: new Uint8Array([1]) }).then(
      () => "ok",
      (error) => error.message,
    ); // "Network connection lost."
    await new Promise((resolve) => setTimeout(resolve, 50));
    // unhandled.length === 0 for every variant
    ```

    In the same repro, a genuine `void Promise.reject(...)` did reach the
    `unhandledrejection` listener and Vitest reported it as an unhandled
    error; the failed `fetch` did neither.

  - Our export body is already a `Uint8Array` (never a stream), the response
    body is cancelled, and `postOtlp` awaits the `fetch` inside a `try`.
  - `sdk.workers.test.ts` ("a failed export leaves no unhandled rejection")
    and the collector-down integration test assert that no
    `unhandledrejection` event fires while exports fail against
    `127.0.0.1:9`, and Vitest would fail either run on any unhandled error.
  - `wrangler dev` did not print the line in the collector-down sample.
    #33 should check the deployed Worker's logs with the collector down
    for the same line or any `waitUntil`/uncaught-exception warning.

### Running locally

```sh
./dev.sh                     # once: shared PostgreSQL, this worktree's database, migrations, seed
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://scos:scos@127.0.0.1:5432/<database>
pnpm --filter @scos/persistence build
pnpm --filter @scos/api dev:worker   # wrangler dev on http://localhost:8787
```

To export to a local Collector, run the Collector from
[Local OpenTelemetry Collector](#local-opentelemetry-collector-test-sink) and
put the OTLP variables in `apps/api/.dev.vars` (or pass
`--var OTEL_TRACES_EXPORTER:otlp --var OTEL_METRICS_EXPORTER:otlp --var OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4318`).

### Sample output from `wrangler dev`

Captured with Wrangler 4.124.0 (`wrangler dev`, local workerd) over this
worktree's migrated and seeded database, exporting OTLP to a local
`otel/opentelemetry-collector:0.104.0` with the `debug` exporter
(`SERVICE_VERSION=0.0.0-issue17`). Requests: health; a verification with
`traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` and
`tracestate: vendor=opaque`; an accepted submission (201); its replay (201);
a shipping rejection (422); a conflicting reuse (409); an invalid body with an
all-zero `traceparent` (400); an unknown path (404). The Collector received
exactly one traces and one metrics export per request. Neither the logs nor
the Collector output contained the submission ID, a coordinate, an order
number or the database credentials.

**Logs**, as Workers Logs stores them (read back from `wrangler dev`'s local
observability store, one event per `console.log` call; shown as JSON):

```json
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.681Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"3ce94046bba211c64322138aceebb881","span_id":"5b9c56ca2522f7e4","trace_flags":"01","http.request.method":"GET","url.scheme":"http","http.response.status_code":200,"http.route":"/health","url.path":"/health","http.server.request.duration":0,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.821Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"0525edb6677be159","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":200,"http.route":"/api/v1/orders/verify","url.path":"/api/v1/orders/verify","http.server.request.duration":0.129,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.894Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"336d5f2a1281d4e09c32b0be8c1eb809","span_id":"aae175715beffb00","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":201,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.061,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.923Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"908dd2f36ce03fe139b9a273804f60c5","span_id":"a9cf36e89faaed73","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":201,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.013,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.965Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"de66374c4dc620f6c90977da12970f1c","span_id":"9ce8751e2055a960","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":422,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.031,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.985Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"1f6978500d9642b4ade1f7388d98ccd7","span_id":"61a34d708ee18f5c","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":409,"http.route":"/api/v1/orders","url.path":"/api/v1/orders","http.server.request.duration":0.009,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:10.997Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"52dd06b3b6a26d65a37281b675860947","span_id":"d535cd9076027a6b","trace_flags":"01","http.request.method":"POST","url.scheme":"http","http.response.status_code":400,"http.route":"/api/v1/orders/verify","url.path":"/api/v1/orders/verify","http.server.request.duration":0,"msg":"request completed"}
{"level":"info","severity_number":9,"time":"2026-09-19T13:10:11.010Z","service.name":"scos-api","service.version":"0.0.0-issue17","deployment.environment.name":"local","trace_id":"f5df9252adc284cb220f95e4278fcb7e","span_id":"26de1bf441ad47c6","trace_flags":"01","http.request.method":"GET","url.scheme":"http","http.response.status_code":404,"url.path":"/nope","http.server.request.duration":0,"msg":"request completed"}
```

The verification record carries the caller's trace ID and the SERVER span's
ID `0525edb6...` below; the all-zero `traceparent` was ignored (new trace
`52dd06b3...`). Durations are whole milliseconds, and `0` without database
I/O, because workerd's clock only advances on I/O. The `wrangler dev`
terminal prints the same objects in inspect format.

**Spans** (Collector `debug` exporter, verification trace, abridged):

```text
Resource attributes:
     -> service.name: Str(scos-api)
     -> service.version: Str(0.0.0-issue17)
     -> deployment.environment.name: Str(local)
ScopeSpans SchemaURL: https://opentelemetry.io/schemas/1.43.0
InstrumentationScope @scos/api 0.0.0
Span #0
    Trace ID       : 4bf92f3577b34da6a3ce929d0e0e4736
    Parent ID      : 21be4ea2bfbed169
    ID             : fc9cc41f5c174d59
    Name           : InventoryReader.readInventorySnapshot
    Kind           : Internal
    TraceState     : vendor=opaque
     -> scos.inventory.warehouse_count: Int(6)
Span #1
    Parent ID      : 0525edb6677be159
    ID             : 21be4ea2bfbed169
    Name           : VerifyOrder
    Kind           : Internal
     -> scos.estimate.valid: Bool(true)
Span #2
    Parent ID      : 00f067aa0ba902b7
    ID             : 0525edb6677be159
    Name           : POST /api/v1/orders/verify
    Kind           : Server
    TraceState     : vendor=opaque
    Status code    : Unset
     -> http.request.method: Str(POST)
     -> url.scheme: Str(http)
     -> url.path: Str(/api/v1/orders/verify)
     -> http.response.status_code: Int(200)
     -> http.route: Str(/api/v1/orders/verify)
```

The accepted submission's trace `336d5f2a1281d4e09c32b0be8c1eb809` (one
export of seven spans):

```text
POST /api/v1/orders                              aae175715beffb00  parent: none              201
  SubmitOrder                                    e5886461249f43cb  outcome=accepted, replayed=false
    SubmissionStore.findOrderBySubmissionKey     2c2b26a345f2bf59  order_found=false
    SubmissionStore.runInTransaction             6462a43a4d1f21fb
      SubmissionTransaction.lockInventory        f2804b395f8d8134  warehouse_count=6
      SubmissionTransaction.findOrderBySubmissionKey 087ff2bba17099b8 order_found=false
      SubmissionTransaction.saveAcceptedOrder    ee002157982cb19f
```

**Metrics** (Collector `debug` exporter; the accepted submission's flush,
abridged):

```text
Metric #0
     -> Name: http.server.request.duration
     -> Unit: s
     -> DataType: Histogram
     -> AggregationTemporality: Delta
Data point attributes:
     -> http.request.method: Str(POST)
     -> url.scheme: Str(http)
     -> http.response.status_code: Int(201)
     -> http.route: Str(/api/v1/orders)
Count: 1
Sum: 0.061000
Metric #1
     -> Name: scos.order.submissions
     -> Unit: {submission}
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Delta
Data point attributes:
     -> scos.submission.outcome: Str(accepted)
     -> scos.submission.replayed: Bool(false)
Value: 1
```

The later flushes carried `accepted`/`replayed=true`, `rejected` with
`rejection_reason=SHIPPING_EXCEEDS_LIMIT`, and `conflict`, each with value 1,
and one `http.server.request.duration` point per request (the 400 and 404
included, the 404 without `http.route`).

**Collector down** (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9`,
`OTEL_EXPORTER_OTLP_TIMEOUT=1000`): both submissions returned `201` (120 ms
and 31 ms), and each request logged one failure per signal:

```json
{"level":"warn","severity_number":13,"time":"2026-09-19T13:06:44.654Z","service.name":"scos-api","service.version":"0.0.0","deployment.environment.name":"local","scos.telemetry.signal":"traces","diagnostic":"Error","msg":"OpenTelemetry export failed"}
{"level":"warn","severity_number":13,"time":"2026-09-19T13:06:44.654Z","service.name":"scos-api","service.version":"0.0.0","deployment.environment.name":"local","scos.telemetry.signal":"metrics","diagnostic":"Error","msg":"OpenTelemetry export failed"}
```

### Workers limitations

- **Verified locally only**, in `wrangler dev` and workerd tests, with
  `wrangler dev` connecting straight to PostgreSQL instead of through a real
  Hyperdrive. Hyperdrive's transaction pooling, Workers Logs and Logpush
  ingestion and CPU time on the Free plan are #33's to verify, and the
  placeholder Hyperdrive ID is #15's to replace (see the
  [Cloudflare deployment design](cloudflare-deployment-design.md)). Hosted
  checks in #33 should also confirm
  that, with the collector down, the deployed Worker's logs show only the
  `OpenTelemetry export failed` warnings (no `Network connection lost`
  uncaught exception, no cancelled-`waitUntil` warning).
- **Clock resolution:** durations and timestamps advance only on I/O (see
  [Metrics and accuracy](#metrics-and-accuracy)).
- **No export retries**; a failed export loses that flush's spans and
  metric deltas, by design.
- **A Prisma client per request** costs some CPU on each database request;
  it was not measured on Cloudflare. If the Free plan's 10 ms CPU limit is a
  problem, #33 measures it.
- **The `workerd` persistence build** is a second generated Prisma client;
  both are generated from the same schema by `prisma generate`.
- **Local observability store:** `wrangler dev` records Cloudflare's own
  request and `fetch` spans locally whatever `traces.enabled` says; that
  setting governs the deployed Worker.

## Versions

Pinned in `apps/api/package.json`:

| Package                                      | Version                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `pino`                                       | 10.3.1                                                  |
| `@opentelemetry/api`                         | 1.9.1                                                   |
| `@opentelemetry/sdk-trace`                   | 2.11.0                                                  |
| `@opentelemetry/sdk-metrics`                 | 2.11.0                                                  |
| `@opentelemetry/resources`                   | 2.11.0                                                  |
| `@opentelemetry/core`                        | 2.11.0                                                  |
| `@opentelemetry/context-async-hooks`         | 2.11.0                                                  |
| `@opentelemetry/exporter-trace-otlp-proto`   | 0.222.0                                                 |
| `@opentelemetry/exporter-metrics-otlp-proto` | 0.222.0                                                 |
| `@opentelemetry/instrumentation`             | 0.222.0                                                 |
| `@opentelemetry/instrumentation-pino`        | 0.68.0 (supports `pino >=5.14.0 <11`)                   |
| `@opentelemetry/semantic-conventions`        | 1.43.0                                                  |
| `@opentelemetry/otlp-transformer` (Workers)  | 0.222.0                                                 |
| `wrangler` (dev)                             | 4.135.0 (workerd 1.20260918.1)                          |
| `@cloudflare/vitest-pool-workers` (dev)      | 0.22.0 (its own wrangler 4.124.0, workerd 1.20260815.1) |

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
  #14, which is deferred; warm reuse and flush behaviour must be verified on
  AWS when that track resumes.
- **Workers: see [its limitations](#workers-limitations)** (clock
  resolution, per-request export cost, no retries, local-only verification).
  Hosted verification on Cloudflare happens in #33.
- **The Collector container recipe was not run** in this change; OTLP export
  was verified against a local HTTP sink.
- **Console exporter output is not JSON** and mixes with JSON logs on stdout;
  it is for local use only.
