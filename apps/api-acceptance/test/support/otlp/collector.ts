/**
 * An in-process fake OTLP/HTTP collector.
 *
 * The API under test runs as a real child process, so its telemetry cannot be
 * observed through an in-memory exporter: it has to leave the process. The
 * server is therefore pointed at this collector, which is a plain HTTP server
 * on an ephemeral loopback port that keeps every request body exactly as it
 * was posted and decodes it on demand (./decode.ts).
 *
 * Keeping the raw bodies matters twice over: the tests assert on decoded
 * spans and metrics, and they also scan the bytes themselves for request
 * data, which catches a leak in a field this decoder does not read.
 *
 * Every export is answered `200` with an empty body, which is a valid, empty
 * `ExportTraceServiceResponse` / `ExportMetricsServiceResponse`: the proto
 * exporters parse the zero bytes as "no partial success" and report a
 * successful export, so a failing export can never be mistaken for one that
 * simply had nothing to send.
 *
 * @module
 */

import { type Server, createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  type DecodedMetric,
  type DecodedSpan,
  decodeMetricsRequest,
  decodeTraceRequest,
} from "#test/support/otlp/decode";

/** The signal paths the exporters post to (`OTEL_EXPORTER_OTLP_ENDPOINT` + these). */
export const TRACES_PATH = "/v1/traces";
export const METRICS_PATH = "/v1/metrics";

/** One export request, kept exactly as it arrived. */
export interface OtlpPayload {
  readonly path: string;
  readonly contentType: string | null;
  readonly body: Buffer;
}

export interface OtlpCollector {
  /** What to pass as OTEL_EXPORTER_OTLP_ENDPOINT. */
  readonly url: string;
  /** Raw bodies exactly as posted, for the byte-level leak scan. */
  payloads(): OtlpPayload[];
  /** Every span from every `/v1/traces` payload, in arrival order. */
  spans(): DecodedSpan[];
  /**
   * Every metric from every `/v1/metrics` payload. The reader is cumulative
   * and exports periodically, so the same instrument appears once per export;
   * a test that wants totals takes the latest point per attribute set.
   */
  metrics(): DecodedMetric[];
  close(): Promise<void>;
}

/** Reads a request body into one buffer. */
async function readBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Starts a collector on 127.0.0.1 with an ephemeral port. */
export async function startCollector(): Promise<OtlpCollector> {
  const payloads: OtlpPayload[] = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    void readBody(request).then(
      (body) => {
        payloads.push({
          path,
          contentType: request.headers["content-type"] ?? null,
          body,
        });
        // An unexpected path is answered 404 rather than accepted silently,
        // so a wrong endpoint shows up as a failed export in the server's own
        // diagnostics instead of as missing telemetry here.
        const known = path === TRACES_PATH || path === METRICS_PATH;
        response.writeHead(known ? 200 : 404, { "Content-Type": "application/x-protobuf" });
        response.end();
      },
      () => {
        response.writeHead(400);
        response.end();
      },
    );
  });

  server.listen(0, "127.0.0.1");
  // Without the `error` race a failed bind never settles, and the real reason
  // is lost behind the hook timeout.
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => {
      throw new Error(`The fake OTLP collector could not listen: ${(error as Error).message}`);
    }),
  ]);
  const address = server.address() as AddressInfo;

  const bodiesOf = (path: string) =>
    payloads.filter((payload) => payload.path === path).map((payload) => payload.body);

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    payloads: () => [...payloads],
    spans: () => bodiesOf(TRACES_PATH).flatMap(decodeTraceRequest),
    metrics: () => bodiesOf(METRICS_PATH).flatMap(decodeMetricsRequest),
    async close() {
      // The exporter's keep-alive sockets outlive the child process, so they
      // are destroyed rather than waited on: a collector left open would keep
      // the test run's event loop alive.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
