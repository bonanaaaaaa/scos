/**
 * The documentation routes: the OpenAPI document at `GET /openapi.json` and
 * Swagger UI at `GET /docs`. Mounted only by the combined app (`createApp`),
 * not by the per-endpoint apps, and not listed in the document itself.
 *
 * @module
 */

import { swaggerUI } from "@hono/swagger-ui";
import type { Hono } from "hono";

import { createEndpointApp } from "#http/endpoint-app";
import type { Logger } from "#http/logger";
import { MESSAGES } from "#http/messages";
import {
  DOCS_PATH,
  OPENAPI_PATH,
  generateOpenApiDocument,
  serializeOpenApiDocument,
} from "#openapi/document";

export { DOCS_PATH, OPENAPI_PATH };

/**
 * The swagger-ui-dist release the page loads from the jsDelivr CDN. Pinned so
 * the UI cannot change underneath the API; without it the CDN serves latest.
 */
export const SWAGGER_UI_VERSION = "5.33.0";

/**
 * hono-openapi generates the document of `documented` (the combined app) at
 * runtime, once, on the first request; it is served as the exact bytes of the
 * offline export (the build's `apps/api/dist/openapi.json`), which is
 * generated the same way from the same routes. Swagger UI loads it from
 * {@link OPENAPI_PATH} and sends "Try it out" requests to the same origin (the
 * document's server URL is `/`).
 */
export function createDocsApp(logger: Logger, documented: Hono): Hono {
  const app = createEndpointApp(logger, () => MESSAGES.internal);
  // Shared by concurrent first requests; forgotten on failure so the next
  // request generates again instead of failing forever (the failed request
  // itself is a 500 through the error handler).
  let document: Promise<string> | undefined;
  app.get(OPENAPI_PATH, async (c) => {
    document ??= generateOpenApiDocument(documented)
      .then(serializeOpenApiDocument)
      .catch((error: unknown) => {
        document = undefined;
        throw error;
      });
    return c.body(await document, 200, { "Content-Type": "application/json; charset=UTF-8" });
  });
  app.get(
    DOCS_PATH,
    swaggerUI({ url: OPENAPI_PATH, title: "SCOS Ordering API", version: SWAGGER_UI_VERSION }),
  );
  return app;
}
