/**
 * The documentation routes: the OpenAPI document at `GET /openapi.json` and
 * Swagger UI at `GET /docs`. Mounted only by the combined app (`createApp`),
 * not by the per-endpoint apps, and not listed in the document itself.
 *
 * @module
 */

import { swaggerUI } from "@hono/swagger-ui";
import type { Hono } from "hono";

import { createEndpointApp } from "../http/endpoint-app";
import type { Logger } from "../http/logger";
import { MESSAGES } from "../http/messages";
import { renderOpenApiDocument } from "./document";

export const OPENAPI_PATH = "/openapi.json";
export const DOCS_PATH = "/docs";

/**
 * The swagger-ui-dist release the page loads from the jsDelivr CDN. Pinned so
 * the UI cannot change underneath the API; without it the CDN serves latest.
 */
export const SWAGGER_UI_VERSION = "5.33.0";

/**
 * The document is rendered once, on the first request, and served as the
 * exact bytes of the offline export (`docs/openapi.json`). Swagger UI loads
 * it from {@link OPENAPI_PATH} and sends "Try it out" requests to the same
 * origin (the document's server URL is `/`).
 */
export function createDocsApp(logger: Logger): Hono {
  const app = createEndpointApp(logger, () => MESSAGES.internal);
  let document: string | undefined;
  app.get(OPENAPI_PATH, (c) => {
    document ??= renderOpenApiDocument();
    return c.body(document, 200, { "Content-Type": "application/json; charset=UTF-8" });
  });
  app.get(
    DOCS_PATH,
    swaggerUI({ url: OPENAPI_PATH, title: "SCOS Ordering API", version: SWAGGER_UI_VERSION }),
  );
  return app;
}
