/**
 * Every OpenAPI example is true: it parses with its Zod schema, validates
 * with Ajv against the generated JSON Schema, and is exactly what the app
 * returns when the paired request is replayed through the real core use cases
 * over the seed inventory.
 */

import { describe, expect, test } from "vitest";

import {
  EXAMPLE_ORDER_NUMBER,
  submitOrderRequestExamples,
} from "../endpoints/submit-order/examples";
import { verifyOrderRequestExamples } from "../endpoints/verify-order/examples";
import {
  type ExampleMap,
  type ResponseContract,
  type RouteContract,
  notFoundResponse,
} from "../http/route-contract";
import { routes } from "../routes";
import { post } from "../testing/fixtures.test-support";
import { ajvAccepts, specValidator } from "../testing/openapi.test-support";
import { type SeededAppOptions, seededApp } from "../testing/seeded-use-cases.test-support";
import { type JsonObject, buildOpenApiDocument } from "./document";

const document = buildOpenApiDocument();
const validator = specValidator(document);

/** Request examples that are deliberately invalid (they document a 400). */
const MALFORMED = "malformed";

function mediaType(route: RouteContract, status?: number): JsonObject {
  const operation = document.paths[route.path]?.[route.method] as JsonObject;
  const container =
    status === undefined
      ? (operation.requestBody as JsonObject)
      : ((operation.responses as JsonObject)[String(status)] as JsonObject);
  return (container.content as JsonObject)["application/json"] as JsonObject;
}

const allRoutes = Object.values(routes) as RouteContract[];

describe("examples match their schemas", () => {
  test.each(allRoutes.filter((route) => route.requestBody !== undefined))(
    "request examples of $method $path",
    (route) => {
      const media = mediaType(route);
      expect(media.examples).toStrictEqual(route.requestExamples);
      const validate = validator.schema(media.schema as JsonObject);
      for (const [name, example] of Object.entries(route.requestExamples ?? {})) {
        const valid = name !== MALFORMED;
        expect(route.requestBody?.safeParse(example.value).success, name).toBe(valid);
        expect(ajvAccepts(validate, example.value), name).toBe(valid);
      }
    },
  );

  const responses = allRoutes.flatMap((route) =>
    Object.entries(route.responses).map(([status, response]) => ({
      route,
      status: Number(status),
      response: response as ResponseContract,
    })),
  );

  test.each(responses)("$route.method $route.path $status", ({ route, status, response }) => {
    const media = mediaType(route, status);
    expect(
      Object.keys(response.examples ?? {}).length,
      "every response has an example",
    ).toBeGreaterThan(0);
    expect(media.examples).toStrictEqual(response.examples);
    const validate = validator.schema(media.schema as JsonObject);
    for (const [name, example] of Object.entries(response.examples ?? {})) {
      expect(response.schema.safeParse(example.value).success, name).toBe(true);
      expect(
        ajvAccepts(validate, example.value),
        `${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  test("the reusable 404 response example", () => {
    const validate = validator.component("ErrorResponse");
    for (const example of Object.values(notFoundResponse.examples ?? {})) {
      expect(notFoundResponse.schema.safeParse(example.value).success).toBe(true);
      expect(ajvAccepts(validate, example.value)).toBe(true);
    }
    expect(document.components.responses.NotFound).toMatchObject({
      content: { "application/json": { examples: notFoundResponse.examples } },
    });
  });
});

interface Replay {
  /** The response example this replay must reproduce, as `status/name`. */
  readonly expect: string;
  readonly request: { readonly body: string; readonly contentType?: string };
  readonly options?: SeededAppOptions;
  /** Requests sent first to the same app, such as the acceptance before a conflict. */
  readonly before?: readonly unknown[];
}

const json = (examples: ExampleMap, name: string) => ({
  body: JSON.stringify(examples[name]?.value),
});

const verifyReplays: readonly Replay[] = [
  { expect: "200/validEstimate", request: json(verifyOrderRequestExamples, "validEstimate") },
  {
    expect: "200/insufficientStock",
    request: json(verifyOrderRequestExamples, "insufficientStock"),
  },
  {
    expect: "200/shippingExceedsLimit",
    request: json(verifyOrderRequestExamples, "shippingExceedsLimit"),
  },
  { expect: "400/malformed", request: json(verifyOrderRequestExamples, "malformed") },
  {
    expect: "400/unsupportedContentType",
    request: { ...json(verifyOrderRequestExamples, "validEstimate"), contentType: "text/plain" },
  },
  { expect: "400/malformedJson", request: { body: "{" } },
  {
    expect: "500/internalError",
    request: json(verifyOrderRequestExamples, "validEstimate"),
    options: { inventoryFails: true },
  },
];

const accepted = submitOrderRequestExamples.accepted.value;

const submitReplays: readonly Replay[] = [
  { expect: "201/accepted", request: json(submitOrderRequestExamples, "accepted") },
  {
    expect: "201/repeated",
    request: json(submitOrderRequestExamples, "repeated"),
    before: [accepted],
  },
  { expect: "400/malformed", request: json(submitOrderRequestExamples, "malformed") },
  {
    expect: "400/unsupportedContentType",
    request: { ...json(submitOrderRequestExamples, "accepted"), contentType: "text/plain" },
  },
  { expect: "400/malformedJson", request: { body: "{" } },
  {
    expect: "409/changedInput",
    request: json(submitOrderRequestExamples, "changedInput"),
    before: [accepted],
  },
  {
    expect: "422/insufficientStock",
    request: json(submitOrderRequestExamples, "insufficientStock"),
  },
  {
    expect: "422/shippingExceedsLimit",
    request: json(submitOrderRequestExamples, "shippingExceedsLimit"),
  },
  {
    expect: "500/internalError",
    request: json(submitOrderRequestExamples, "accepted"),
    options: { submissionFailure: "unexpected" },
  },
  {
    expect: "503/unavailable",
    request: json(submitOrderRequestExamples, "accepted"),
    options: { submissionFailure: "transient" },
  },
];

function exampleNames(route: RouteContract): string[] {
  return Object.entries(route.responses).flatMap(([status, response]) =>
    Object.keys((response as ResponseContract).examples ?? {}).map((name) => `${status}/${name}`),
  );
}

describe("examples are what the API returns over the seeded inventory", () => {
  test.each([
    { route: routes.health as RouteContract, replays: [] as readonly Replay[] },
    { route: routes.verifyOrder as RouteContract, replays: verifyReplays },
    { route: routes.submitOrder as RouteContract, replays: submitReplays },
  ])("$route.method $route.path", async ({ route, replays }) => {
    if (route.method === "get") {
      const response = await seededApp().request(route.path);
      expect(await response.text()).toBe(JSON.stringify(route.responses[200]?.examples?.ok?.value));
      return;
    }
    expect(replays.map((replay) => replay.expect).sort()).toStrictEqual(exampleNames(route).sort());
    for (const replay of replays) {
      const app = seededApp({ orderNumber: EXAMPLE_ORDER_NUMBER, ...replay.options });
      for (const earlier of replay.before ?? []) {
        expect((await post(app, route.path, earlier)).status).toBe(201);
      }
      const response = await post(app, route.path, replay.request.body, replay.request.contentType);
      const [status = "", name = ""] = replay.expect.split("/");
      const example = route.responses[Number(status)]?.examples?.[name];
      expect(response.status, replay.expect).toBe(Number(status));
      // Byte for byte: the example's key order is the serializer's.
      expect(await response.text(), replay.expect).toBe(JSON.stringify(example?.value));
      if (status === "503") {
        expect(response.headers.get("Retry-After")).toBe(
          String(route.responses[503]?.headers?.["Retry-After"]?.example),
        );
      }
    }
  });

  test("a repeated submissionId returns a byte-identical body and deducts nothing", async () => {
    const app = seededApp({ orderNumber: EXAMPLE_ORDER_NUMBER });
    const first = await (await post(app, routes.submitOrder.path, accepted)).text();
    const second = await (await post(app, routes.submitOrder.path, accepted)).text();
    expect(second).toBe(first);
    const examples = routes.submitOrder.responses[201].examples;
    expect(JSON.stringify(examples.repeated.value)).toBe(JSON.stringify(examples.accepted.value));
  });

  test("a rejected submissionId is not stored and can be retried", async () => {
    const app = seededApp({ orderNumber: EXAMPLE_ORDER_NUMBER });
    const rejected = submitOrderRequestExamples.insufficientStock.value;
    expect((await post(app, routes.submitOrder.path, rejected)).status).toBe(422);
    expect((await post(app, routes.submitOrder.path, rejected)).status).toBe(422);
    const retried = { ...accepted, submissionId: rejected.submissionId };
    expect((await post(app, routes.submitOrder.path, retried)).status).toBe(201);
  });
});
