import {
  type SubmissionStore,
  TransientSubmissionError,
  createSubmitOrder,
  createVerifyOrder,
  orderRequestSchema,
} from "@scos/core";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "vitest";

import { inventory, submitBody, verifyBody } from "../testing/fixtures.test-support";
import { memorySubmissionStore } from "../testing/telemetry-contract.test-support";
import { attributesOf, testTelemetry } from "../testing/telemetry.test-support";
import {
  traceInventoryReader,
  traceSubmissionStore,
  traceSubmitOrder,
  traceVerifyOrder,
} from "./decorators";
import { SUBMISSIONS_METRIC } from "./telemetry";

let harness = testTelemetry();

afterEach(async () => {
  await harness.shutdown();
  harness = testTelemetry();
});

function tracedSubmit(store: SubmissionStore = memorySubmissionStore(), maxAttempts = 3) {
  const { telemetry } = harness;
  return traceSubmitOrder(
    createSubmitOrder({ store: traceSubmissionStore(store, telemetry), maxAttempts }),
    telemetry,
  );
}

describe("VerifyOrder and InventoryReader span details", () => {
  test("an invalid estimate is a business answer: reason recorded, status unset", async () => {
    const verify = traceVerifyOrder(
      createVerifyOrder({ inventoryReader: { readInventorySnapshot: async () => inventory } }),
      harness.telemetry,
    );
    await verify(orderRequestSchema.parse({ quantity: 1_000, latitude: 0, longitude: 0 }));
    expect(harness.span("VerifyOrder").attributes).toStrictEqual({
      "scos.estimate.valid": false,
      "scos.estimate.reason": "INSUFFICIENT_STOCK",
    });
    expect(harness.span("VerifyOrder").status.code).toBe(SpanStatusCode.UNSET);
  });

  test("a database failure is recorded sanitized: type and code, never the message", async () => {
    const failure = Object.assign(
      new Error(
        "select * from warehouse where id = $1 -- leaky-sql connection postgresql://u:leaky@h",
      ),
      { name: "DatabaseError", code: "57P01", severity: "FATAL" },
    );
    const reader = traceInventoryReader(
      {
        readInventorySnapshot: async () => {
          throw failure;
        },
      },
      harness.telemetry,
    );
    const verify = traceVerifyOrder(
      createVerifyOrder({ inventoryReader: reader }),
      harness.telemetry,
    );

    await expect(verify(orderRequestSchema.parse(verifyBody))).rejects.toBe(failure);

    for (const name of ["VerifyOrder", "InventoryReader.readInventorySnapshot"]) {
      const span = harness.span(name);
      expect(span.status).toStrictEqual({ code: SpanStatusCode.ERROR });
      expect(span.attributes).toStrictEqual({
        "error.type": "DatabaseError",
        "scos.error.code": "57P01",
        "db.response.status_code": "57P01",
      });
      expect(span.events.map((event) => [event.name, event.attributes])).toStrictEqual([
        ["exception", { "exception.type": "DatabaseError", "scos.error.code": "57P01" }],
      ]);
    }
    expect(
      JSON.stringify(harness.finished().map((span) => [span.attributes, span.events, span.status])),
    ).not.toMatch(/leaky|select/);
  });
});

describe("Node errno codes are not SQLSTATEs", () => {
  test.each(["EPIPE", "EPERM"])(
    "%s: scos.error.code only, no db.response.status_code",
    async (errno) => {
      const failure = Object.assign(new Error(`write ${errno}`), { code: errno });
      const reader = traceInventoryReader(
        {
          readInventorySnapshot: async () => {
            throw failure;
          },
        },
        harness.telemetry,
      );
      await expect(reader.readInventorySnapshot()).rejects.toBe(failure);
      const span = harness.span("InventoryReader.readInventorySnapshot");
      expect(span.attributes).toStrictEqual({ "error.type": "Error", "scos.error.code": errno });
      expect(span.attributes).not.toHaveProperty("db.response.status_code");
    },
  );
});

describe("SubmitOrder and persistence span failures", () => {
  test("retries inside the use case are counted once; `unavailable` fails the SubmitOrder span", async () => {
    const store = memorySubmissionStore();
    let attempts = 0;
    const submit = tracedSubmit(
      {
        ...store,
        async runInTransaction() {
          attempts += 1;
          // As persistence raises it: Prisma's P2010 carrying the driver SQLSTATE.
          throw new TransientSubmissionError("lock timeout on warehouse leaky", {
            cause: Object.assign(new Error("raw query failed: leaky"), {
              code: "P2010",
              meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
            }),
          });
        },
      },
      3,
    );

    const outcome = await submit(submitBody);

    expect(outcome).toStrictEqual({ kind: "unavailable", attempts: 3 });
    expect(attempts).toBe(3);
    expect(attributesOf(await harness.points(SUBMISSIONS_METRIC))).toStrictEqual([
      { "scos.submission.outcome": "unavailable", "scos.submission.replayed": false },
    ]);
    expect((await harness.points(SUBMISSIONS_METRIC))[0]?.value).toBe(1);
    const submitSpan = harness.span("SubmitOrder");
    expect(submitSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(submitSpan.attributes["error.type"]).toBe("unavailable");
    const transactions = harness
      .finished()
      .filter((span) => span.name === "SubmissionStore.runInTransaction");
    expect(transactions).toHaveLength(3);
    for (const span of transactions) {
      expect(span.attributes).toStrictEqual({
        "error.type": "TransientSubmissionError",
        "scos.error.code": "55P03",
        "db.response.status_code": "55P03",
      });
    }
    expect(JSON.stringify(harness.finished().map((span) => span.events))).not.toContain("leaky");
  });

  test("an unexpected error counts once as `error` with a sanitized type, and fails the spans", async () => {
    const failure = new RangeError("INSERT INTO order VALUES (leaky-coordinates 12.34)");
    const submit = tracedSubmit({
      ...memorySubmissionStore(),
      runInTransaction: async () => {
        throw failure;
      },
    });

    await expect(submit(submitBody)).rejects.toBe(failure);

    expect(attributesOf(await harness.points(SUBMISSIONS_METRIC))).toStrictEqual([
      {
        "scos.submission.outcome": "error",
        "scos.submission.replayed": false,
        "error.type": "RangeError",
      },
    ]);
    expect(harness.span("SubmitOrder").status.code).toBe(SpanStatusCode.ERROR);
    expect(harness.span("SubmitOrder").attributes).toStrictEqual({ "error.type": "RangeError" });
    expect(
      JSON.stringify(harness.finished().map((span) => [span.attributes, span.events])),
    ).not.toMatch(/leaky|12\.34|INSERT/);
  });
});
