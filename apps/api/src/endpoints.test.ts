import {
  type InventorySnapshot,
  type Order,
  type OrderEstimate,
  type SubmitOrder,
  type SubmitOrderOutcome,
  type VerifyOrder,
  createOrder,
  estimateOrder,
  orderRequestSchema,
  submissionKeySchema,
} from "@scos/core";
import type { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";

import {
  MESSAGES,
  createApp,
  createHealthApp,
  createSubmitOrderApp,
  createVerifyOrderApp,
} from "./app";
import { errorResponseSchema, routes } from "./http/contracts";

const inventory: InventorySnapshot = [
  {
    warehouseId: "01996000-0000-7000-8000-000000000001",
    latitude: 0,
    longitude: 0,
    available: 100,
  },
];
const estimateFor = (quantity: number, latitude: number, longitude: number): OrderEstimate =>
  estimateOrder(orderRequestSchema.parse({ quantity, latitude, longitude }), inventory);

const valid = estimateFor(30, 0, 0.5);
const shipping = estimateFor(1, 90, 0);
const insufficient = estimateFor(1_000, 0, 0);
const order: Order = {
  ...createOrder({
    orderNumber: "SO-0123456789AB",
    submissionKey: submissionKeySchema.parse("order-1"),
    estimate: valid,
  }),
  id: "01996000-0000-7000-8000-00000000abcd",
};

const verifyBody = { quantity: 30, latitude: 0, longitude: 0.5 };
const submitBody = { submissionId: "order-1", ...verifyBody };

interface Case {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly contentType?: string;
  readonly verify?: VerifyOrder;
  readonly submit?: SubmitOrder;
}

const json = (value: unknown) => JSON.stringify(value);
const fail = async (): Promise<never> => {
  throw new Error("database password=secret");
};
const outcome =
  (value: SubmitOrderOutcome): SubmitOrder =>
  async () =>
    value;
const estimate =
  (value: OrderEstimate): VerifyOrder =>
  async () =>
    value;

const verifyCases: readonly Case[] = [
  {
    name: "valid",
    method: "POST",
    path: "/orders/verify",
    body: json(verifyBody),
    verify: estimate(valid),
  },
  {
    name: "shipping",
    method: "POST",
    path: "/orders/verify",
    body: json(verifyBody),
    verify: estimate(shipping),
  },
  {
    name: "insufficient",
    method: "POST",
    path: "/orders/verify",
    body: json(verifyBody),
    verify: estimate(insufficient),
  },
  {
    name: "invalid body",
    method: "POST",
    path: "/orders/verify",
    body: json({ ...verifyBody, x: 1 }),
  },
  { name: "malformed JSON", method: "POST", path: "/orders/verify", body: "{" },
  { name: "empty body", method: "POST", path: "/orders/verify", body: "" },
  {
    name: "text/plain",
    method: "POST",
    path: "/orders/verify",
    body: json(verifyBody),
    contentType: "text/plain",
  },
  {
    name: "use case throws",
    method: "POST",
    path: "/orders/verify",
    body: json(verifyBody),
    verify: fail,
  },
];

const submitCases: readonly Case[] = [
  {
    name: "accepted",
    method: "POST",
    path: "/orders",
    body: json(submitBody),
    submit: outcome({ kind: "accepted", order, replayed: false }),
  },
  {
    name: "replayed",
    method: "POST",
    path: "/orders",
    body: json(submitBody),
    submit: outcome({ kind: "accepted", order, replayed: true }),
  },
  ...(["INSUFFICIENT_STOCK", "SHIPPING_EXCEEDS_LIMIT"] as const).map((reason) => ({
    name: reason,
    method: "POST",
    path: "/orders",
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
    path: "/orders",
    body: json(submitBody),
    submit: outcome({ kind: "conflict", submissionKey: submissionKeySchema.parse("order-1") }),
  },
  {
    name: "invalid outcome",
    method: "POST",
    path: "/orders",
    body: json(submitBody),
    submit: outcome({
      kind: "invalid",
      issues: [{ code: "custom", path: ["quantity"], message: "bad", input: 1 }],
    }),
  },
  {
    name: "unavailable",
    method: "POST",
    path: "/orders",
    body: json(submitBody),
    submit: outcome({ kind: "unavailable", attempts: 3 }),
  },
  {
    name: "invalid body",
    method: "POST",
    path: "/orders",
    body: json({ ...submitBody, submissionId: " " }),
  },
  { name: "malformed JSON", method: "POST", path: "/orders", body: "{" },
  {
    name: "no content type",
    method: "POST",
    path: "/orders",
    body: json(submitBody),
    contentType: "",
  },
  {
    name: "use case throws",
    method: "POST",
    path: "/orders",
    body: json(submitBody),
    submit: fail,
  },
];

const healthCases: readonly Case[] = [
  { name: "health", method: "GET", path: "/health" },
  { name: "HEAD health", method: "HEAD", path: "/health" },
];

const unknownCases: readonly Case[] = [
  { name: "unknown path", method: "GET", path: "/nope" },
  { name: "wrong method", method: "DELETE", path: "/orders/verify" },
  { name: "GET orders", method: "GET", path: "/orders" },
  { name: "POST health", method: "POST", path: "/health" },
];

const noVerify: VerifyOrder = async () => {
  throw new Error("verify must not be called");
};
const noSubmit: SubmitOrder = async () => {
  throw new Error("submit must not be called");
};
const silent = () => ({ error: vi.fn() });

async function send(app: Hono, request: Case) {
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

function combined(request: Case, logger = silent()) {
  return createApp({
    verifyOrder: request.verify ?? noVerify,
    submitOrder: request.submit ?? noSubmit,
    logger,
  });
}

describe("each standalone endpoint app responds byte-identically to the combined app", () => {
  test.each(verifyCases)("createVerifyOrderApp: $name", async (request) => {
    const standalone = createVerifyOrderApp({
      verifyOrder: request.verify ?? noVerify,
      logger: silent(),
    });
    expect(await send(standalone, request)).toStrictEqual(await send(combined(request), request));
  });

  test.each(submitCases)("createSubmitOrderApp: $name", async (request) => {
    const standalone = createSubmitOrderApp({
      submitOrder: request.submit ?? noSubmit,
      logger: silent(),
    });
    expect(await send(standalone, request)).toStrictEqual(await send(combined(request), request));
  });

  test.each(healthCases)("createHealthApp: $name", async (request) => {
    expect(await send(createHealthApp(), request)).toStrictEqual(
      await send(combined(request), request),
    );
  });

  test.each(unknownCases)("404 envelope for $name on every app", async (request) => {
    const expected = await send(combined(request), request);
    expect(expected.status).toBe(404);
    for (const app of [
      createHealthApp(),
      createVerifyOrderApp({ verifyOrder: noVerify }),
      createSubmitOrderApp({ submitOrder: noSubmit }),
    ]) {
      expect(await send(app, request)).toStrictEqual(expected);
    }
  });
});

describe("each standalone app serves only its own route", () => {
  const apps = {
    health: () => createHealthApp(),
    verifyOrder: () => createVerifyOrderApp({ verifyOrder: estimate(valid) }),
    submitOrder: () =>
      createSubmitOrderApp({ submitOrder: outcome({ kind: "accepted", order, replayed: false }) }),
  } as const;
  const requests = {
    health: { name: "health", method: "GET", path: routes.health.path },
    verifyOrder: {
      name: "verify",
      method: "POST",
      path: routes.verifyOrder.path,
      body: json(verifyBody),
    },
    submitOrder: {
      name: "submit",
      method: "POST",
      path: routes.submitOrder.path,
      body: json(submitBody),
    },
  } as const;
  const served = { health: 200, verifyOrder: 200, submitOrder: 201 } as const;

  test.each(Object.keys(apps) as (keyof typeof apps)[])("%s", async (name) => {
    expect(routes[name].servedBy).toBe(
      {
        health: "createHealthApp",
        verifyOrder: "createVerifyOrderApp",
        submitOrder: "createSubmitOrderApp",
      }[name],
    );
    for (const route of Object.keys(requests) as (keyof typeof requests)[]) {
      const response = await send(apps[name](), requests[route]);
      if (route === name) {
        expect(response.status).toBe(served[name]);
      } else {
        expect(response.status).toBe(404);
        expect(errorResponseSchema.parse(JSON.parse(response.body)).error.code).toBe("NOT_FOUND");
      }
    }
  });
});

describe("mounting keeps each endpoint's error handling", () => {
  test("a failure is handled once, by the mounted app, with its route's message", async () => {
    const logger = silent();
    const app = createApp({ verifyOrder: fail, submitOrder: fail, logger });

    const verify = await send(app, verifyCases.at(-1) as Case);
    const submit = await send(app, submitCases.at(-1) as Case);

    expect(JSON.parse(verify.body)).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
    });
    expect(JSON.parse(submit.body)).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.submitInternal },
    });
    expect(verify.body + submit.body).not.toContain("secret");
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(
      logger.error.mock.calls.map(([, details]) => (details as { path: string }).path),
    ).toStrictEqual(["/orders/verify", "/orders"]);
  });

  test("the health app needs no dependencies and logs to the console by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await createHealthApp().request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({ status: "ok" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
