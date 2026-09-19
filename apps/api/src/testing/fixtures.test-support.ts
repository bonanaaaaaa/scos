/**
 * Shared unit-test fixtures: real core estimates and an Order built over a
 * one-warehouse inventory, request bodies, and request/response helpers.
 */

import {
  type InventorySnapshot,
  type Order,
  type OrderEstimate,
  createOrder,
  estimateOrder,
  orderRequestSchema,
  submissionKeySchema,
} from "@scos/core";
import type { Hono } from "hono";
import { expect, vi } from "vitest";
import type { z } from "zod";

import type { Logger } from "../http/logger";

// One warehouse at (0, 0) with 100 units: 30 units shipped 55.6 km is valid,
// 1 unit to the North Pole costs more than 15% of $150, and 1 000 is too many.
export const inventory: InventorySnapshot = [
  {
    warehouseId: "01996000-0000-7000-8000-000000000001",
    latitude: 0,
    longitude: 0,
    available: 100,
  },
];

export function estimateFor(quantity: number, latitude: number, longitude: number): OrderEstimate {
  return estimateOrder(orderRequestSchema.parse({ quantity, latitude, longitude }), inventory);
}

export const validEstimate = estimateFor(30, 0, 0.5);
export const shippingEstimate = estimateFor(1, 90, 0);
export const insufficientEstimate = estimateFor(1_000, 0, 0);

export const acceptedOrder: Order = {
  ...createOrder({
    orderNumber: "SO-0123456789AB",
    submissionKey: submissionKeySchema.parse("order-1"),
    estimate: validEstimate,
  }),
  id: "01996000-0000-7000-8000-00000000abcd",
};

export const verifyBody = { quantity: 30, latitude: 0, longitude: 0.5 };
export const submitBody = { submissionId: "order-1", ...verifyBody };

export function fakeLogger() {
  return { error: vi.fn<Logger["error"]>() };
}

export function post(app: Hono, path: string, body: unknown, contentType = "application/json") {
  return app.request(path, {
    method: "POST",
    headers: contentType === "" ? {} : { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Asserts a JSON response and parses its body with `schema`. */
export async function json<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  return schema.parse(await response.json());
}
