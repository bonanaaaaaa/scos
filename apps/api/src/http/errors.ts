/**
 * The error envelope every endpoint uses for non-2xx responses: its codes,
 * schemas and the helpers that build it.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SubmitOrderIssue } from "@scos/core";
import type { Context } from "hono";
import { z } from "zod";

import { MESSAGES } from "./messages";

/** Every error code any endpoint returns: the envelope's shared vocabulary. */
export const ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "SUBMISSION_ID_CONFLICT",
  "INSUFFICIENT_STOCK",
  "SHIPPING_EXCEEDS_LIMIT",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.output<typeof errorCodeSchema>;

export const errorIssueSchema = z.object({
  /** Location of the problem in the request body; `[]` is the body itself. */
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export type ErrorIssue = z.output<typeof errorIssueSchema>;

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  issues: z.array(errorIssueSchema).optional(),
});

/** The envelope of every non-2xx response. */
export const errorResponseSchema = z.object({ error: errorBodySchema });

export type ErrorResponse = z.output<typeof errorResponseSchema>;

export function errorBody(code: ErrorCode, message: string, issues?: readonly ErrorIssue[]) {
  const body: ErrorResponse = { error: { code, message } };
  if (issues !== undefined) {
    body.error.issues = [...issues];
  }
  return body;
}

function pathSegment(segment: PropertyKey | StandardSchemaV1.PathSegment): string | number {
  const key = typeof segment === "object" ? segment.key : segment;
  return typeof key === "number" ? key : String(key);
}

/** Schema or use-case issues as envelope issues: `path` and `message` only. */
export function toIssues(
  issues: readonly (StandardSchemaV1.Issue | SubmitOrderIssue)[],
): readonly ErrorIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map(pathSegment),
    message: issue.message,
  }));
}

export function invalidRequest(c: Context, message: string, issues?: readonly ErrorIssue[]) {
  return c.json(errorBody("INVALID_REQUEST", message, issues), 400);
}

export function notFound(c: Context) {
  return c.json(errorBody("NOT_FOUND", MESSAGES.notFound), 404);
}
