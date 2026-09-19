/**
 * Public surface of the API adapter. Importing it reads no environment and
 * opens no connection:
 *
 * - app construction, per endpoint and combined, the HTTP contract and the
 *   OpenAPI document built from it (no server or database needed);
 * - the per-endpoint and combined compositions (they connect lazily, on the
 *   first query) and the per-runtime configuration parsers.
 *
 * The local listener lives in `server.ts`.
 *
 * @module
 */

import { corePackage } from "@scos/core";
import { persistencePackage } from "@scos/persistence";

// Apps
export { type AppDependencies, createApp } from "./app";
export { type HealthAppOptions, createHealthApp } from "./endpoints/health/app";
export {
  type SubmitOrderAppDependencies,
  createSubmitOrderApp,
} from "./endpoints/submit-order/app";
export {
  type VerifyOrderAppDependencies,
  createVerifyOrderApp,
} from "./endpoints/verify-order/app";
export {
  type Logger,
  type StructuredLogger,
  createConsoleJsonLogger,
  defaultLogger,
} from "./http/logger";

// Compositions
export { type CompositionOptions, composeApplication } from "./composition";
export {
  type ComposedApplication,
  type DatabaseCompositionOptions,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  databasePoolTimeouts,
} from "./database";
export { composeHealthApplication } from "./endpoints/health/composition";
export {
  type SubmitOrderCompositionOptions,
  composeSubmitOrderApplication,
} from "./endpoints/submit-order/composition";
export {
  type VerifyOrderCompositionOptions,
  composeVerifyOrderApplication,
} from "./endpoints/verify-order/composition";

// Configuration
export {
  type DatabaseConfig,
  type ParseResult,
  type ServerConfig,
  parseConfig,
  parseDatabaseConfig,
} from "./config";
export { type HealthConfig, parseHealthConfig } from "./endpoints/health/config";

// Contracts
export { routes } from "./routes";
export {
  type ErrorCode,
  type ErrorIssue,
  type ErrorResponse,
  ERROR_CODES,
  errorBodySchema,
  errorCodeSchema,
  errorIssueSchema,
  errorResponseSchema,
} from "./http/errors";
export { healthResponseSchema } from "./endpoints/health/contract";
export {
  type VerifyOrderRequest,
  type VerifyOrderResponse,
  verifyOrderRequestSchema,
  verifyOrderResponseSchema,
} from "./endpoints/verify-order/contract";
export {
  type OrderResponse,
  type RejectedSubmissionResponse,
  type SubmitOrderRequest,
  RETRY_AFTER_SECONDS,
  orderAllocationSchema,
  orderResponseSchema,
  rejectedSubmissionResponseSchema,
  submissionIdFieldSchema,
  submitOrderRequestSchema,
} from "./endpoints/submit-order/contract";
export {
  type RejectedEstimate,
  estimateAllocationSchema,
  insufficientStockEstimateSchema,
  shippingExceedsLimitEstimateSchema,
  validEstimateSchema,
} from "./http/estimate";
export {
  API_PREFIX,
  type EndpointApp,
  type ExampleContract,
  type ExampleMap,
  type HeaderContract,
  type ResponseContract,
  type RouteContract,
  notFoundResponse,
} from "./http/route-contract";
export {
  destinationResponseSchema,
  discountRateSchema,
  latitudeFieldSchema,
  longitudeFieldSchema,
  moneySchema,
  quantityFieldSchema,
  responseQuantitySchema,
  warehouseIdSchema,
} from "./http/schemas";

// OpenAPI
export {
  DOCS_PATH,
  OPENAPI_PATH,
  type JsonObject,
  type OpenApiDocument,
  generateOpenApiDocument,
  serializeOpenApiDocument,
} from "./openapi/document";
export { buildOpenApiDocument, renderOpenApiDocument } from "./openapi/offline";

export function workspaceComposition(): readonly string[] {
  return [corePackage.name, persistencePackage.name];
}
