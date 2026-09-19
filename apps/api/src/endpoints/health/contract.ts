/**
 * Contract of `GET /health`.
 *
 * @module
 */

import { z } from "zod";

import type { RouteContract } from "../../http/route-contract";

export const healthResponseSchema = z.object({ status: z.literal("ok") });

export const healthRoute = {
  servedBy: "createHealthApp",
  method: "get",
  path: "/health",
  summary: "Liveness check; does not touch the database.",
  responses: {
    200: { description: "The process is running.", schema: healthResponseSchema },
  },
} as const satisfies RouteContract;
