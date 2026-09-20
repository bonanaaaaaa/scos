/**
 * Decoding the two OTLP export requests the API sends into plain objects.
 *
 * `ExportTraceServiceRequest` and `ExportMetricsServiceRequest` are decoded
 * down to the fields the acceptance tests assert on: span identity,
 * correlation, kind, status and attributes; metric identity, sum and
 * histogram data points. Everything else (links, exemplars, gauges,
 * exponential histograms, schema URLs) is stepped over by ./wire.ts rather
 * than guessed at.
 *
 * The field numbers below are transcribed from the serializers the server
 * actually uses — `@opentelemetry/otlp-transformer`'s
 * `trace/protobuf/trace-serializer.js`, `metrics/protobuf/metrics-serializer.js`
 * and `common/protobuf/common-serializer.js` — and each message's comment
 * repeats them, so a change in the wire contract is visible here rather than
 * showing up as a mysteriously empty assertion.
 *
 * @module
 */

import {
  asDouble,
  asHex,
  asSfixed64,
  asSigned,
  asText,
  asUint64,
  fields,
  packedDoubles,
  packedFixed64,
} from "./wire";

// ---------------------------------------------------------------------------
// Common: AnyValue, KeyValue, InstrumentationScope, Resource
// ---------------------------------------------------------------------------

/** A decoded `AnyValue`; `null` is the proto's value-less AnyValue. */
export type AnyValue = string | boolean | number | Uint8Array | AnyValue[] | AnyValueMap | null;

export interface AnyValueMap {
  readonly [key: string]: AnyValue;
}

/** A decoded repeated `KeyValue`, as the attribute map it represents. */
export type Attributes = AnyValueMap;

/**
 * AnyValue:
 *   1 string_value (string), 2 bool_value (varint), 3 int_value (varint),
 *   4 double_value (fixed64), 5 array_value, 6 kvlist_value, 7 bytes_value.
 *
 * `int_value` is an int64; it is returned as a JavaScript number because
 * every integer attribute this API sets is small (a status code, a count).
 */
const ANY_VALUE_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7]);
/** ArrayValue: 1 values (repeated AnyValue). KeyValueList: 1 values (repeated KeyValue). */
const VALUES_FIELD = new Set([1]);
/** KeyValue: 1 key (string), 2 value (AnyValue). */
const KEY_VALUE_FIELDS = new Set([1, 2]);

function decodeAnyValue(buffer: Buffer): AnyValue {
  for (const field of fields(buffer, ANY_VALUE_FIELDS)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      return asText(field.value);
    }
    if (field.fieldNumber === 2 && field.wireType === 0) {
      return field.value !== 0n;
    }
    if (field.fieldNumber === 3 && field.wireType === 0) {
      return Number(asSigned(field.value));
    }
    if (field.fieldNumber === 4 && field.wireType === 1) {
      return asDouble(field.value);
    }
    if (field.fieldNumber === 5 && field.wireType === 2) {
      const items: AnyValue[] = [];
      for (const item of fields(field.value, VALUES_FIELD)) {
        if (item.wireType === 2) {
          items.push(decodeAnyValue(item.value));
        }
      }
      return items;
    }
    if (field.fieldNumber === 6 && field.wireType === 2) {
      return decodeAttributes(field.value, VALUES_FIELD);
    }
    if (field.fieldNumber === 7 && field.wireType === 2) {
      return Uint8Array.from(field.value);
    }
  }
  // An AnyValue with no field set: the proto's empty value.
  return null;
}

function decodeKeyValue(buffer: Buffer): { key: string; value: AnyValue } {
  let key = "";
  let value: AnyValue = null;
  for (const field of fields(buffer, KEY_VALUE_FIELDS)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      key = asText(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      value = decodeAnyValue(field.value);
    }
  }
  return { key, value };
}

/**
 * Every `KeyValue` of `buffer` carried by the field numbers in `wanted`, as
 * an attribute map. The attribute field number differs per message (9 on a
 * Span, 7 on a NumberDataPoint, and so on), so the caller names it.
 */
function decodeAttributes(buffer: Buffer, wanted: ReadonlySet<number>): Attributes {
  const attributes: Record<string, AnyValue> = {};
  for (const field of fields(buffer, wanted)) {
    if (field.wireType === 2) {
      const { key, value } = decodeKeyValue(field.value);
      attributes[key] = value;
    }
  }
  return attributes;
}

export interface DecodedScope {
  readonly name: string;
  readonly version: string;
}

/** InstrumentationScope: 1 name (string), 2 version (string). */
const SCOPE_FIELDS = new Set([1, 2]);

function decodeScope(buffer: Buffer): DecodedScope {
  let name = "";
  let version = "";
  for (const field of fields(buffer, SCOPE_FIELDS)) {
    if (field.wireType !== 2) {
      continue;
    }
    if (field.fieldNumber === 1) {
      name = asText(field.value);
    } else {
      version = asText(field.value);
    }
  }
  return { name, version };
}

/** Resource: 1 attributes (repeated KeyValue). */
const RESOURCE_ATTRIBUTES = new Set([1]);

function decodeResource(buffer: Buffer): Attributes {
  return decodeAttributes(buffer, RESOURCE_ATTRIBUTES);
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/**
 * The proto's `SpanKind`, which is the SDK's kind plus one: the API has no
 * value for "unset", so the serializer writes `span.kind + 1` and reserves 0
 * for UNSPECIFIED. Indexing this list by the encoded value undoes that.
 */
const SPAN_KINDS = ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"] as const;
export type SpanKindName = (typeof SPAN_KINDS)[number];

const STATUS_CODES = ["UNSET", "OK", "ERROR"] as const;
export type StatusCodeName = (typeof STATUS_CODES)[number];

/** `Span.flags`: the parent's `is_remote` is known, and it is remote. */
export const SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE = 0x100;
export const SPAN_FLAGS_CONTEXT_IS_REMOTE = 0x200;

export interface DecodedEvent {
  readonly name: string;
  readonly timeUnixNano: bigint;
  readonly attributes: Attributes;
}

export interface DecodedStatus {
  readonly code: StatusCodeName;
  readonly message: string;
}

export interface DecodedSpan {
  /** The resource of the ResourceSpans this span arrived in. */
  readonly resource: Attributes;
  /** The scope of the ScopeSpans this span arrived in. */
  readonly scope: DecodedScope;
  /** Lowercase hex, as the correlated log records carry it. */
  readonly traceId: string;
  readonly spanId: string;
  /** Lowercase hex, or `""` when the span is a root. */
  readonly parentSpanId: string;
  readonly name: string;
  readonly kind: SpanKindName;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly attributes: Attributes;
  readonly events: readonly DecodedEvent[];
  readonly status: DecodedStatus;
  /** `Span.flags`: the low byte is the trace flags, plus the is-remote bits. */
  readonly flags: number;
}

/** True when this span continued a trace started by a remote caller. */
export function hasRemoteParent(span: DecodedSpan): boolean {
  return (
    (span.flags & SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE) !== 0 &&
    (span.flags & SPAN_FLAGS_CONTEXT_IS_REMOTE) !== 0
  );
}

/** Status: 2 message (string), 3 code (varint). */
const STATUS_FIELDS = new Set([2, 3]);

function decodeStatus(buffer: Buffer): DecodedStatus {
  let code: StatusCodeName = "UNSET";
  let message = "";
  for (const field of fields(buffer, STATUS_FIELDS)) {
    if (field.fieldNumber === 2 && field.wireType === 2) {
      message = asText(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 0) {
      code = STATUS_CODES[Number(field.value)] ?? "UNSET";
    }
  }
  return { code, message };
}

/** Span.Event: 1 time_unix_nano (fixed64), 2 name (string), 3 attributes. */
const EVENT_FIELDS = new Set([1, 2, 3]);

function decodeEvent(buffer: Buffer): DecodedEvent {
  let name = "";
  let timeUnixNano = 0n;
  const attributes: Record<string, AnyValue> = {};
  for (const field of fields(buffer, EVENT_FIELDS)) {
    if (field.fieldNumber === 1 && field.wireType === 1) {
      timeUnixNano = asUint64(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      name = asText(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      const { key, value } = decodeKeyValue(field.value);
      attributes[key] = value;
    }
  }
  return { name, timeUnixNano, attributes };
}

/**
 * Span:
 *   1 trace_id (bytes), 2 span_id (bytes), 4 parent_span_id (bytes),
 *   5 name (string), 6 kind (varint), 7 start_time_unix_nano (fixed64),
 *   8 end_time_unix_nano (fixed64), 9 attributes (repeated KeyValue),
 *   11 events (repeated Event), 15 status (Status), 16 flags (fixed32).
 */
const SPAN_FIELDS = new Set([1, 2, 4, 5, 6, 7, 8, 9, 11, 15, 16]);

function decodeSpan(buffer: Buffer, resource: Attributes, scope: DecodedScope): DecodedSpan {
  let traceId = "";
  let spanId = "";
  let parentSpanId = "";
  let name = "";
  let kind: SpanKindName = "UNSPECIFIED";
  let startTimeUnixNano = 0n;
  let endTimeUnixNano = 0n;
  const attributes: Record<string, AnyValue> = {};
  const events: DecodedEvent[] = [];
  let status: DecodedStatus = { code: "UNSET", message: "" };
  let flags = 0;
  for (const field of fields(buffer, SPAN_FIELDS)) {
    if (field.wireType === 2) {
      switch (field.fieldNumber) {
        case 1:
          traceId = asHex(field.value);
          break;
        case 2:
          spanId = asHex(field.value);
          break;
        case 4:
          parentSpanId = asHex(field.value);
          break;
        case 5:
          name = asText(field.value);
          break;
        case 9: {
          const { key, value } = decodeKeyValue(field.value);
          attributes[key] = value;
          break;
        }
        case 11:
          events.push(decodeEvent(field.value));
          break;
        case 15:
          status = decodeStatus(field.value);
          break;
        default:
          break;
      }
    } else if (field.wireType === 1 && field.fieldNumber === 7) {
      startTimeUnixNano = asUint64(field.value);
    } else if (field.wireType === 1 && field.fieldNumber === 8) {
      endTimeUnixNano = asUint64(field.value);
    } else if (field.wireType === 0 && field.fieldNumber === 6) {
      kind = SPAN_KINDS[Number(field.value)] ?? "UNSPECIFIED";
    } else if (field.wireType === 5 && field.fieldNumber === 16) {
      flags = field.value;
    }
  }
  return {
    resource,
    scope,
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    events,
    status,
    flags,
  };
}

/** ExportTraceServiceRequest: 1 resource_spans (repeated ResourceSpans). */
const TRACE_REQUEST_FIELDS = new Set([1]);
/** ResourceSpans: 1 resource (Resource), 2 scope_spans (repeated ScopeSpans). */
const RESOURCE_SPANS_FIELDS = new Set([1, 2]);
/** ScopeSpans: 1 scope (InstrumentationScope), 2 spans (repeated Span). */
const SCOPE_SPANS_FIELDS = new Set([1, 2]);

/** Every span of one `POST /v1/traces` body, flattened. */
export function decodeTraceRequest(body: Buffer): DecodedSpan[] {
  const spans: DecodedSpan[] = [];
  for (const resourceSpans of fields(body, TRACE_REQUEST_FIELDS)) {
    if (resourceSpans.wireType !== 2) {
      continue;
    }
    let resource: Attributes = {};
    const scopeBodies: Buffer[] = [];
    for (const field of fields(resourceSpans.value, RESOURCE_SPANS_FIELDS)) {
      if (field.wireType !== 2) {
        continue;
      }
      if (field.fieldNumber === 1) {
        resource = decodeResource(field.value);
      } else {
        scopeBodies.push(field.value);
      }
    }
    // The resource precedes the scopes in every payload the exporter writes,
    // but the spans are collected after the whole ResourceSpans is read, so
    // the order on the wire cannot change what a span reports.
    for (const scopeSpans of scopeBodies) {
      let scope: DecodedScope = { name: "", version: "" };
      const spanBodies: Buffer[] = [];
      for (const field of fields(scopeSpans, SCOPE_SPANS_FIELDS)) {
        if (field.wireType !== 2) {
          continue;
        }
        if (field.fieldNumber === 1) {
          scope = decodeScope(field.value);
        } else {
          spanBodies.push(field.value);
        }
      }
      for (const span of spanBodies) {
        spans.push(decodeSpan(span, resource, scope));
      }
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const TEMPORALITIES = ["UNSPECIFIED", "DELTA", "CUMULATIVE"] as const;
export type TemporalityName = (typeof TEMPORALITIES)[number];

export interface DecodedNumberPoint {
  readonly attributes: Attributes;
  readonly startTimeUnixNano: bigint;
  readonly timeUnixNano: bigint;
  /** `as_int` or `as_double`, whichever the instrument used. */
  readonly value: number;
}

export interface DecodedHistogramPoint {
  readonly attributes: Attributes;
  readonly startTimeUnixNano: bigint;
  readonly timeUnixNano: bigint;
  readonly count: number;
  readonly sum: number | undefined;
  readonly bucketCounts: readonly number[];
  readonly explicitBounds: readonly number[];
}

export interface DecodedSum {
  readonly dataPoints: readonly DecodedNumberPoint[];
  readonly aggregationTemporality: TemporalityName;
  readonly isMonotonic: boolean;
}

export interface DecodedHistogram {
  readonly dataPoints: readonly DecodedHistogramPoint[];
  readonly aggregationTemporality: TemporalityName;
}

export interface DecodedMetric {
  readonly resource: Attributes;
  readonly scope: DecodedScope;
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  /** Present for a counter; `undefined` for every other instrument. */
  readonly sum: DecodedSum | undefined;
  /** Present for a histogram; `undefined` for every other instrument. */
  readonly histogram: DecodedHistogram | undefined;
}

/**
 * NumberDataPoint:
 *   2 start_time_unix_nano (fixed64), 3 time_unix_nano (fixed64),
 *   4 as_double (double), 6 as_int (sfixed64), 7 attributes.
 */
const NUMBER_POINT_FIELDS = new Set([2, 3, 4, 6, 7]);

function decodeNumberPoint(buffer: Buffer): DecodedNumberPoint {
  let startTimeUnixNano = 0n;
  let timeUnixNano = 0n;
  let value = 0;
  const attributes: Record<string, AnyValue> = {};
  for (const field of fields(buffer, NUMBER_POINT_FIELDS)) {
    if (field.wireType === 1) {
      if (field.fieldNumber === 2) {
        startTimeUnixNano = asUint64(field.value);
      } else if (field.fieldNumber === 3) {
        timeUnixNano = asUint64(field.value);
      } else if (field.fieldNumber === 4) {
        value = asDouble(field.value);
      } else {
        value = Number(asSfixed64(field.value));
      }
    } else if (field.wireType === 2 && field.fieldNumber === 7) {
      const entry = decodeKeyValue(field.value);
      attributes[entry.key] = entry.value;
    }
  }
  return { attributes, startTimeUnixNano, timeUnixNano, value };
}

/**
 * HistogramDataPoint:
 *   2 start_time_unix_nano (fixed64), 3 time_unix_nano (fixed64),
 *   4 count (fixed64), 5 sum (double), 6 bucket_counts (packed fixed64),
 *   7 explicit_bounds (packed double), 9 attributes.
 */
const HISTOGRAM_POINT_FIELDS = new Set([2, 3, 4, 5, 6, 7, 9]);

function decodeHistogramPoint(buffer: Buffer): DecodedHistogramPoint {
  let startTimeUnixNano = 0n;
  let timeUnixNano = 0n;
  let count = 0;
  let sum: number | undefined;
  let bucketCounts: number[] = [];
  let explicitBounds: number[] = [];
  const attributes: Record<string, AnyValue> = {};
  for (const field of fields(buffer, HISTOGRAM_POINT_FIELDS)) {
    if (field.wireType === 1) {
      if (field.fieldNumber === 2) {
        startTimeUnixNano = asUint64(field.value);
      } else if (field.fieldNumber === 3) {
        timeUnixNano = asUint64(field.value);
      } else if (field.fieldNumber === 4) {
        count = Number(asUint64(field.value));
      } else if (field.fieldNumber === 5) {
        sum = asDouble(field.value);
      }
    } else if (field.wireType === 2) {
      if (field.fieldNumber === 6) {
        bucketCounts = packedFixed64(field.value).map(Number);
      } else if (field.fieldNumber === 7) {
        explicitBounds = packedDoubles(field.value);
      } else if (field.fieldNumber === 9) {
        const entry = decodeKeyValue(field.value);
        attributes[entry.key] = entry.value;
      }
    } else {
      // `bucket_counts` and `explicit_bounds` are repeated scalars, which a
      // writer may legally send unpacked. The exporter always packs them, so
      // this cannot happen today; dropping them silently would make the
      // bucket assertions vacuous, so fail loudly instead.
      throw new Error(
        `HistogramDataPoint field ${field.fieldNumber} arrived with wire type ${field.wireType}, which this reader does not decode`,
      );
    }
  }
  return {
    attributes,
    startTimeUnixNano,
    timeUnixNano,
    count,
    sum,
    bucketCounts,
    explicitBounds,
  };
}

/** Sum: 1 data_points, 2 aggregation_temporality (varint), 3 is_monotonic (varint). */
const SUM_FIELDS = new Set([1, 2, 3]);
/** Histogram: 1 data_points, 2 aggregation_temporality (varint). */
const HISTOGRAM_FIELDS = new Set([1, 2]);

function decodeSum(buffer: Buffer): DecodedSum {
  const dataPoints: DecodedNumberPoint[] = [];
  let aggregationTemporality: TemporalityName = "UNSPECIFIED";
  let isMonotonic = false;
  for (const field of fields(buffer, SUM_FIELDS)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      dataPoints.push(decodeNumberPoint(field.value));
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      aggregationTemporality = TEMPORALITIES[Number(field.value)] ?? "UNSPECIFIED";
    } else if (field.fieldNumber === 3 && field.wireType === 0) {
      isMonotonic = field.value !== 0n;
    }
  }
  return { dataPoints, aggregationTemporality, isMonotonic };
}

function decodeHistogram(buffer: Buffer): DecodedHistogram {
  const dataPoints: DecodedHistogramPoint[] = [];
  let aggregationTemporality: TemporalityName = "UNSPECIFIED";
  for (const field of fields(buffer, HISTOGRAM_FIELDS)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      dataPoints.push(decodeHistogramPoint(field.value));
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      aggregationTemporality = TEMPORALITIES[Number(field.value)] ?? "UNSPECIFIED";
    }
  }
  return { dataPoints, aggregationTemporality };
}

/**
 * Metric:
 *   1 name (string), 2 description (string), 3 unit (string),
 *   7 sum (Sum), 9 histogram (Histogram).
 */
const METRIC_FIELDS = new Set([1, 2, 3, 7, 9]);

function decodeMetric(buffer: Buffer, resource: Attributes, scope: DecodedScope): DecodedMetric {
  let name = "";
  let description = "";
  let unit = "";
  let sum: DecodedSum | undefined;
  let histogram: DecodedHistogram | undefined;
  for (const field of fields(buffer, METRIC_FIELDS)) {
    if (field.wireType !== 2) {
      continue;
    }
    switch (field.fieldNumber) {
      case 1:
        name = asText(field.value);
        break;
      case 2:
        description = asText(field.value);
        break;
      case 3:
        unit = asText(field.value);
        break;
      case 7:
        sum = decodeSum(field.value);
        break;
      case 9:
        histogram = decodeHistogram(field.value);
        break;
      default:
        break;
    }
  }
  return { resource, scope, name, description, unit, sum, histogram };
}

/** ExportMetricsServiceRequest: 1 resource_metrics (repeated ResourceMetrics). */
const METRICS_REQUEST_FIELDS = new Set([1]);
/** ResourceMetrics: 1 resource (Resource), 2 scope_metrics (repeated ScopeMetrics). */
const RESOURCE_METRICS_FIELDS = new Set([1, 2]);
/** ScopeMetrics: 1 scope (InstrumentationScope), 2 metrics (repeated Metric). */
const SCOPE_METRICS_FIELDS = new Set([1, 2]);

/** Every metric of one `POST /v1/metrics` body, flattened. */
export function decodeMetricsRequest(body: Buffer): DecodedMetric[] {
  const metrics: DecodedMetric[] = [];
  for (const resourceMetrics of fields(body, METRICS_REQUEST_FIELDS)) {
    if (resourceMetrics.wireType !== 2) {
      continue;
    }
    let resource: Attributes = {};
    const scopeBodies: Buffer[] = [];
    for (const field of fields(resourceMetrics.value, RESOURCE_METRICS_FIELDS)) {
      if (field.wireType !== 2) {
        continue;
      }
      if (field.fieldNumber === 1) {
        resource = decodeResource(field.value);
      } else {
        scopeBodies.push(field.value);
      }
    }
    for (const scopeMetrics of scopeBodies) {
      let scope: DecodedScope = { name: "", version: "" };
      const metricBodies: Buffer[] = [];
      for (const field of fields(scopeMetrics, SCOPE_METRICS_FIELDS)) {
        if (field.wireType !== 2) {
          continue;
        }
        if (field.fieldNumber === 1) {
          scope = decodeScope(field.value);
        } else {
          metricBodies.push(field.value);
        }
      }
      for (const metric of metricBodies) {
        metrics.push(decodeMetric(metric, resource, scope));
      }
    }
  }
  return metrics;
}
