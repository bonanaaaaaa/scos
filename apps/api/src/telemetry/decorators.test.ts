import {
  type NewOrder,
  type Order,
  type SubmissionStore,
  TransientSubmissionError,
  createSubmitOrder,
  createVerifyOrder,
  orderRequestSchema,
} from "@scos/core";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "vitest";

import { inventory, submitBody, verifyBody } from "../testing/fixtures.test-support";
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

/** An in-memory SubmissionStore over the one-warehouse fixture inventory. */
function memoryStore(): SubmissionStore {
  const orders = new Map<string, Order>();
  let stock = inventory;
  return {
    findOrderBySubmissionKey: async (key) => orders.get(key) ?? null,
    async runInTransaction(work) {
      return work({
        lockInventory: async () => stock,
        findOrderBySubmissionKey: async (key) => orders.get(key) ?? null,
        async saveAcceptedOrder(order: NewOrder) {
          const saved: Order = { ...order, id: "01996000-0000-7000-8000-00000000abcd" };
          orders.set(order.submissionKey, saved);
          stock = stock.map((warehouse) => ({
            ...warehouse,
            available: warehouse.available - order.quantity,
          }));
          return saved;
        },
      });
    },
  };
}

function tracedSubmit(store: SubmissionStore = memoryStore(), maxAttempts = 3) {
  const { telemetry } = harness;
  return traceSubmitOrder(
    createSubmitOrder({ store: traceSubmissionStore(store, telemetry), maxAttempts }),
    telemetry,
  );
}

function names() {
  return harness.finished().map((span) => span.name);
}

describe("VerifyOrder and InventoryReader spans", () => {
  test("a valid estimate: VerifyOrder parents the inventory read; no error status", async () => {
    const reader = traceInventoryReader(
      { readInventorySnapshot: async () => inventory },
      harness.telemetry,
    );
    const verify = traceVerifyOrder(
      createVerifyOrder({ inventoryReader: reader }),
      harness.telemetry,
    );

    const estimate = await verify(orderRequestSchema.parse(verifyBody));

    expect(estimate.valid).toBe(true);
    const outer = harness.span("VerifyOrder");
    const read = harness.span("InventoryReader.readInventorySnapshot");
    expect(outer.kind).toBe(SpanKind.INTERNAL);
    expect(read.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(outer.attributes).toStrictEqual({ "scos.estimate.valid": true });
    expect(read.attributes).toStrictEqual({ "scos.inventory.warehouse_count": 1 });
    expect(outer.status.code).toBe(SpanStatusCode.UNSET);
    expect(outer.duration[0] * 1e9 + outer.duration[1]).toBeGreaterThanOrEqual(0);
  });

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

describe("SubmitOrder and persistence spans", () => {
  test("a new Order: SubmitOrder > unlocked lookup, transaction > lock, locked lookup, save", async () => {
    const outcome = await tracedSubmit()(submitBody);
    expect(outcome.kind).toBe("accepted");

    expect(names()).toStrictEqual([
      "SubmissionStore.findOrderBySubmissionKey",
      "SubmissionTransaction.lockInventory",
      "SubmissionTransaction.findOrderBySubmissionKey",
      "SubmissionTransaction.saveAcceptedOrder",
      "SubmissionStore.runInTransaction",
      "SubmitOrder",
    ]);
    const submit = harness.span("SubmitOrder");
    const transaction = harness.span("SubmissionStore.runInTransaction");
    const parentOf = (name: string) => harness.span(name).parentSpanContext?.spanId;
    expect(parentOf("SubmissionStore.findOrderBySubmissionKey")).toBe(submit.spanContext().spanId);
    expect(parentOf("SubmissionStore.runInTransaction")).toBe(submit.spanContext().spanId);
    for (const name of [
      "SubmissionTransaction.lockInventory",
      "SubmissionTransaction.findOrderBySubmissionKey",
      "SubmissionTransaction.saveAcceptedOrder",
    ]) {
      expect(parentOf(name), name).toBe(transaction.spanContext().spanId);
    }
    expect(submit.attributes).toStrictEqual({
      "scos.submission.outcome": "accepted",
      "scos.submission.replayed": false,
    });
    expect(harness.span("SubmissionStore.findOrderBySubmissionKey").attributes).toStrictEqual({
      "scos.submission.order_found": false,
    });
    for (const span of harness.finished()) {
      expect(span.status.code, span.name).toBe(SpanStatusCode.UNSET);
    }
  });

  test("scos.order.submissions counts every completed call once, replays included", async () => {
    const submit = tracedSubmit();

    await submit(submitBody); // accepted
    await submit(submitBody); // replay of the accepted Order
    await submit(submitBody); // another replay
    await submit({ ...submitBody, quantity: 31 }); // conflict: same key, other inputs
    await submit({ ...submitBody, submissionId: "big", quantity: 1_000 }); // rejected: stock
    await submit({ ...submitBody, submissionId: "far", quantity: 1, latitude: 90 }); // rejected: shipping
    await submit({ submissionId: "x" }); // invalid

    const points = await harness.points(SUBMISSIONS_METRIC);
    const byAttributes = Object.fromEntries(
      points.map((point) => [JSON.stringify(point.attributes), point.value]),
    );
    expect(byAttributes).toStrictEqual({
      [JSON.stringify({
        "scos.submission.outcome": "accepted",
        "scos.submission.replayed": false,
      })]: 1,
      [JSON.stringify({
        "scos.submission.outcome": "accepted",
        "scos.submission.replayed": true,
      })]: 2,
      [JSON.stringify({
        "scos.submission.outcome": "conflict",
        "scos.submission.replayed": false,
      })]: 1,
      [JSON.stringify({
        "scos.submission.outcome": "rejected",
        "scos.submission.replayed": false,
        "scos.submission.rejection_reason": "INSUFFICIENT_STOCK",
      })]: 1,
      [JSON.stringify({
        "scos.submission.outcome": "rejected",
        "scos.submission.replayed": false,
        "scos.submission.rejection_reason": "SHIPPING_EXCEEDS_LIMIT",
      })]: 1,
      [JSON.stringify({
        "scos.submission.outcome": "invalid",
        "scos.submission.replayed": false,
      })]: 1,
    });
    // Rejections and conflicts are business outcomes: no error status.
    for (const span of harness.finished()) {
      expect(span.status.code, span.name).toBe(SpanStatusCode.UNSET);
    }
  });

  test("retries inside the use case are counted once; `unavailable` fails the SubmitOrder span", async () => {
    const store = memoryStore();
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
      ...memoryStore(),
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

  test("no span or counter attribute carries the submission key, order number or coordinates", async () => {
    const secretKey = "customer-secret-key-7f3a";
    const body = { submissionId: secretKey, quantity: 30, latitude: 0.123456, longitude: 0.654321 };
    const submit = tracedSubmit();
    const accepted = await submit(body);
    await submit(body);
    const orderNumber = accepted.kind === "accepted" ? accepted.order.orderNumber : "unreachable";

    const recorded = JSON.stringify([
      harness.finished().map((span) => [span.name, span.attributes, span.events]),
      await harness.points(SUBMISSIONS_METRIC),
    ]);
    for (const secret of [secretKey, orderNumber, "0.123456", "0.654321", "abcd"]) {
      expect(recorded).not.toContain(secret);
    }
  });
});
