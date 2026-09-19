import { describe, expect, test, vi } from "vitest";

import type { DatabaseCompositionOptions } from "../database";
import { composeVerifyOrderApplication } from "../endpoints/verify-order/composition";
import { httpApiEvent, lambdaContext } from "../testing/lambda-events.test-support";
import { databaseLambda } from "./database";
import type { AuthTokenSignerOptions } from "./pool";
import { initializeLambda } from "./runtime";

const proxyHost = "scos.proxy-abcdefghijkl.ap-southeast-1.rds.amazonaws.com";

describe("databaseLambda", () => {
  test("iam mode: initialization builds one signer and one pool, mints no token and connects nowhere", async () => {
    const getAuthToken = vi.fn(async () => "token");
    const signers: AuthTokenSignerOptions[] = [];
    const pools: import("pg").Pool[] = [];
    const compose = vi.fn((options: DatabaseCompositionOptions) =>
      composeVerifyOrderApplication({
        ...options,
        logger: { error: () => undefined },
        createPool: (timeouts) => {
          const pool = options.createPool?.(timeouts);
          if (pool === undefined) {
            throw new Error("expected a Lambda pool");
          }
          pools.push(pool);
          return pool;
        },
      }),
    );

    const { handler, composed } = initializeLambda(
      databaseLambda(compose, (options) => {
        signers.push(options);
        return { getAuthToken };
      }),
      {
        DATABASE_URL: `postgresql://scos_app@${proxyHost}:5432/scos`,
        DATABASE_AUTH_MODE: "iam",
        AWS_REGION: "ap-southeast-1",
      },
    );
    try {
      expect(compose).toHaveBeenCalledOnce();
      expect(compose.mock.calls[0]?.[0].databaseUrl).toBe(
        `postgresql://scos_app@${proxyHost}:5432/scos`,
      );
      expect(signers).toStrictEqual([
        { hostname: proxyHost, port: 5432, username: "scos_app", region: "ap-southeast-1" },
      ]);
      expect(pools).toHaveLength(1);
      expect(pools[0]?.options).toMatchObject({
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 5_000,
        ssl: { rejectUnauthorized: true },
      });

      // Requests rejected before the use case never touch the database.
      const invalid = await handler(
        httpApiEvent("POST", "/api/v1/orders/verify", { body: { quantity: "1" } }),
        lambdaContext(),
      );
      expect(invalid.statusCode).toBe(400);
      expect(getAuthToken).not.toHaveBeenCalled();
      expect(pools[0]?.totalCount).toBe(0);
    } finally {
      await composed.close();
    }
  });
});
