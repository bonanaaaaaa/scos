/**
 * Requests that exercise every branch of every endpoint, sent to two apps so
 * their responses can be compared: the standalone endpoint apps and the
 * combined app must answer identically.
 */

import {
  type OrderEstimate,
  type SubmitOrder,
  type SubmitOrderOutcome,
  type VerifyOrder,
  submissionKeySchema,
} from "@scos/core";
import type { Hono } from "hono";

import { createApp } from "#app";
import {
  acceptedOrder as order,
  fakeLogger,
  insufficientEstimate as insufficient,
  shippingEstimate as shipping,
  submitBody,
  validEstimate as valid,
  verifyBody,
} from "#testing/fixtures.test-support";

export interface Case {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly contentType?: string;
  readonly verify?: VerifyOrder;
  readonly submit?: SubmitOrder;
}

export const json = (value: unknown) => JSON.stringify(value);
export const fail = async (): Promise<never> => {
  throw new Error("database password=secret");
};
export const outcome =
  (value: SubmitOrderOutcome): SubmitOrder =>
  async () =>
    value;
export const estimate =
  (value: OrderEstimate): VerifyOrder =>
  async () =>
    value;

export const verifyCases: readonly Case[] = [
  {
    name: "valid",
    method: "POST",
    path: "/api/v1/orders/verify",
    body: json(verifyBody),
    verify: estimate(valid),
  },
  {
    name: "shipping",
    method: "POST",
    path: "/api/v1/orders/verify",
    body: json(verifyBody),
    verify: estimate(shipping),
  },
  {
    name: "insufficient",
    method: "POST",
    path: "/api/v1/orders/verify",
    body: json(verifyBody),
    verify: estimate(insufficient),
  },
  {
    name: "invalid body",
    method: "POST",
    path: "/api/v1/orders/verify",
    body: json({ ...verifyBody, x: 1 }),
  },
  { name: "malformed JSON", method: "POST", path: "/api/v1/orders/verify", body: "{" },
  { name: "empty body", method: "POST", path: "/api/v1/orders/verify", body: "" },
  {
    name: "text/plain",
    method: "POST",
    path: "/api/v1/orders/verify",
    body: json(verifyBody),
    contentType: "text/plain",
  },
  {
    name: "use case throws",
    method: "POST",
    path: "/api/v1/orders/verify",
    body: json(verifyBody),
    verify: fail,
  },
];

export const submitCases: readonly Case[] = [
  {
    name: "accepted",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: outcome({ kind: "accepted", order, replayed: false }),
  },
  {
    name: "replayed",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: outcome({ kind: "accepted", order, replayed: true }),
  },
  ...(["INSUFFICIENT_STOCK", "SHIPPING_EXCEEDS_LIMIT"] as const).map((reason) => ({
    name: reason,
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: outcome({
      kind: "rejected",
      reason,
      estimate: (reason === "INSUFFICIENT_STOCK" ? insufficient : shipping) as never,
    }),
  })),
  {
    name: "conflict",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: outcome({ kind: "conflict", submissionKey: submissionKeySchema.parse("order-1") }),
  },
  {
    name: "invalid outcome",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: outcome({
      kind: "invalid",
      issues: [{ code: "custom", path: ["quantity"], message: "bad", input: 1 }],
    }),
  },
  {
    name: "unavailable",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: outcome({ kind: "unavailable", attempts: 3 }),
  },
  {
    name: "invalid body",
    method: "POST",
    path: "/api/v1/orders",
    body: json({ ...submitBody, submissionId: " " }),
  },
  { name: "malformed JSON", method: "POST", path: "/api/v1/orders", body: "{" },
  {
    name: "no content type",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    contentType: "",
  },
  {
    name: "use case throws",
    method: "POST",
    path: "/api/v1/orders",
    body: json(submitBody),
    submit: fail,
  },
];

export const healthCases: readonly Case[] = [
  { name: "health", method: "GET", path: "/health" },
  { name: "HEAD health", method: "HEAD", path: "/health" },
];

export const unknownCases: readonly Case[] = [
  { name: "unknown path", method: "GET", path: "/nope" },
  { name: "wrong method", method: "DELETE", path: "/api/v1/orders/verify" },
  { name: "GET orders", method: "GET", path: "/api/v1/orders" },
  { name: "POST health", method: "POST", path: "/health" },
];

export const noVerify: VerifyOrder = async () => {
  throw new Error("verify must not be called");
};
export const noSubmit: SubmitOrder = async () => {
  throw new Error("submit must not be called");
};
export const silent = () => fakeLogger();

export async function send(app: Hono, request: Case) {
  const headers: Record<string, string> = {};
  const contentType = request.contentType ?? "application/json";
  if (request.body !== undefined && contentType !== "") {
    headers["Content-Type"] = contentType;
  }
  const response = await app.request(request.path, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
    body: await response.text(),
  };
}

export function combined(request: Case, logger = silent()) {
  return createApp({
    verifyOrder: request.verify ?? noVerify,
    submitOrder: request.submit ?? noSubmit,
    logger,
  });
}
