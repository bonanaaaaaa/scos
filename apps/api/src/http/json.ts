/**
 * JSON request handling shared by every endpoint with a body: the
 * Content-Type guard and the Standard Schema validator with the 400 hook.
 *
 * @module
 */

import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { MiddlewareHandler } from "hono";

import { invalidRequest, toIssues } from "./errors";
import { MESSAGES } from "./messages";

/** Same test Hono's validator uses to decide whether it parses the body. */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/**
 * Rejects bodies Hono would not parse as JSON. Without this, the validator
 * would validate `{}` and report missing fields, hiding the real problem.
 */
export const requireJson: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.header("Content-Type");
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    return invalidRequest(c, MESSAGES.unsupportedContentType);
  }
  await next();
};

/** Validates the JSON body; a schema failure is `400 INVALID_REQUEST` with issues. */
export function jsonBody<Schema extends StandardSchemaV1>(schema: Schema) {
  return sValidator("json", schema, (result, c) => {
    if (!result.success) {
      return invalidRequest(c, MESSAGES.invalidBody, toIssues(result.error));
    }
    return undefined;
  });
}
