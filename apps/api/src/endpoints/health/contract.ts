/**
 * Contract of `GET /health`.
 *
 * @module
 */

import { z } from "zod";

import type { RouteContract } from "../../http/route-contract";

export const healthResponseSchema = z
  .object({ status: z.literal("ok") })
  .meta({ id: "HealthResponse", description: "The process is running." });

export const healthRoute = {
  servedBy: "createHealthApp",
  operationId: "health",
  method: "get",
  path: "/health",
  summary: "Liveness check; does not touch the database.",
  description:
    "A liveness probe outside the versioned API: it answers while PostgreSQL is unavailable.",
  responses: {
    200: {
      description: "The process is running. PostgreSQL availability is not checked.",
      schema: healthResponseSchema,
      examples: { ok: { summary: "Running", value: { status: "ok" } } },
    },
  },
} as const satisfies RouteContract;
