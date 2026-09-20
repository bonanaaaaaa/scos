import { afterEach, describe, expect, test, vi } from "vitest";

import { factorySpies } from "#testing/persistence-spies.test-support";
import { DEFAULT_TELEMETRY_CONFIG } from "#testing/telemetry.test-support";

// Spy on the adapter factories while keeping their real behaviour.
vi.mock("@scos/persistence", async (importOriginal) =>
  (await import("#testing/persistence-spies.test-support")).spyOnFactories(await importOriginal()),
);

const persistence = await import("@scos/persistence");
const { composeHealthApplication } = await import("#endpoints/health/composition");
const { parseHealthConfig } = await import("#endpoints/health/config");
const { calls } = factorySpies(persistence);

afterEach(() => {
  vi.clearAllMocks();
});

describe("composeHealthApplication builds only what health needs", () => {
  test("health: no database configuration, no pool and no adapters", async () => {
    expect(parseHealthConfig({})).toStrictEqual({
      success: true,
      config: { telemetry: DEFAULT_TELEMETRY_CONFIG },
    });
    const composed = composeHealthApplication();
    const response = await composed.app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "ok" });
    expect((await composed.app.request("/api/v1/orders", { method: "POST" })).status).toBe(404);
    await composed.close();
    expect(calls()).toStrictEqual({ pool: 0, prisma: 0, inventoryReader: 0, submissionStore: 0 });
  });
});
