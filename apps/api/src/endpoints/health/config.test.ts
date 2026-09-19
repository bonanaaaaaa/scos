import { describe, expect, test } from "vitest";

import { parseHealthConfig } from "./config";

describe("parseHealthConfig", () => {
  test("health ignores every variable", () => {
    expect(parseHealthConfig({ DATABASE_URL: "garbage", PORT: "x" })).toStrictEqual({
      success: true,
      config: {},
    });
  });
});
