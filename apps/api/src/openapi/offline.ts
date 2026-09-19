/**
 * The OpenAPI document without a server, environment or database: hono-openapi
 * generates it from `createApp` built with stub use cases, which only
 * construction touches (no request is ever made). The routes and their
 * documentation do not depend on the use cases, so this is the document the
 * running server serves at `GET /openapi.json`.
 *
 * @module
 */

import type { SubmitOrder, VerifyOrder } from "@scos/core";
import type { Hono } from "hono";

import { createApp } from "../app";
import type { Logger } from "../http/logger";
import {
  type OpenApiDocument,
  generateOpenApiDocument,
  serializeOpenApiDocument,
} from "./document";

function unused(): never {
  throw new Error("The offline OpenAPI app does not handle requests.");
}

const silentLogger: Logger = { error: () => undefined };

/** The combined app over stub use cases: routes and documentation only. */
export function offlineApp(): Hono {
  return createApp({
    verifyOrder: unused as VerifyOrder,
    submitOrder: unused as SubmitOrder,
    logger: silentLogger,
  });
}

/** The document of the combined app, generated offline. */
export function buildOpenApiDocument(): Promise<OpenApiDocument> {
  return generateOpenApiDocument(offlineApp());
}

/** The offline document as exported to `docs/openapi.json`. */
export async function renderOpenApiDocument(): Promise<string> {
  return serializeOpenApiDocument(await buildOpenApiDocument());
}
