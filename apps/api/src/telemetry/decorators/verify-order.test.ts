import { createVerifyOrder, orderRequestSchema } from "@scos/core";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "vitest";

import { inventory, verifyBody } from "#testing/fixtures.test-support";
import { testTelemetry } from "#testing/telemetry.test-support";
import { traceInventoryReader } from "#telemetry/decorators/inventory-reader";
import { traceVerifyOrder } from "#telemetry/decorators/verify-order";

let harness = testTelemetry();

afterEach(async () => {
  await harness.shutdown();
  harness = testTelemetry();
});

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
