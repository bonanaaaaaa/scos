import { describe, expect, test } from "vitest";

import { DEFAULT_PORT, parseConfig, parseDatabaseConfig } from "./config";

const databaseUrl = "postgresql://scos:secret-password@localhost:5432/scos";

describe("parseConfig", () => {
  test("accepts a PostgreSQL URL and defaults PORT to 3000", () => {
    expect(parseConfig({ DATABASE_URL: databaseUrl })).toStrictEqual({
      success: true,
      config: { databaseUrl, port: DEFAULT_PORT },
    });
    expect(DEFAULT_PORT).toBe(3000);
    expect(parseConfig({ DATABASE_URL: "postgres://db.internal/scos" }).success).toBe(true);
  });

  test("ports accept the boundaries and reject anything but an integer in range", () => {
    for (const [port, expected] of [
      ["0", 0],
      ["65535", 65_535],
      ["8080", 8080],
    ] as const) {
      expect(parseConfig({ DATABASE_URL: databaseUrl, PORT: port })).toMatchObject({
        success: true,
        config: { port: expected },
      });
    }
    for (const port of ["", "1.5", "-1", "65536", "99999", "0x10", "1e3", " 80", "abc"]) {
      const result = parseConfig({ DATABASE_URL: databaseUrl, PORT: port });
      expect(result, port).toStrictEqual({
        success: false,
        errors: ["PORT: must be an integer between 0 and 65535"],
      });
    }
  });

  test("DATABASE_URL is required and must be a postgres URL with a host", () => {
    expect(parseConfig({})).toStrictEqual({
      success: false,
      errors: ["DATABASE_URL: is required"],
    });
    expect(parseConfig({ DATABASE_URL: "" })).toStrictEqual({
      success: false,
      errors: ["DATABASE_URL: is required"],
    });
    for (const value of [
      "not a url",
      "mysql://root:secret-password@localhost/scos",
      "postgresql:///scos",
      "http://localhost:5432/scos",
    ]) {
      expect(parseConfig({ DATABASE_URL: value }), value).toStrictEqual({
        success: false,
        errors: ["DATABASE_URL: must be a postgres:// or postgresql:// URL with a host"],
      });
    }
  });

  test("reports every invalid variable without echoing values", () => {
    const result = parseConfig({ DATABASE_URL: "mysql://u:secret-password@h/d", PORT: "70000" });

    expect(result.success).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("PORT");
    expect(text).not.toContain("secret-password");
    expect(text).not.toContain("70000");
  });
});

describe("parseDatabaseConfig", () => {
  test("verify and submit require DATABASE_URL only", () => {
    const databaseUrl = "postgresql://scos:secret@127.0.0.1:1/scos";
    expect(parseDatabaseConfig({ DATABASE_URL: databaseUrl, PORT: "not-a-port" })).toStrictEqual({
      success: true,
      config: { databaseUrl },
    });
    expect(parseDatabaseConfig({})).toStrictEqual({
      success: false,
      errors: ["DATABASE_URL: is required"],
    });
    const invalid = parseDatabaseConfig({ DATABASE_URL: "mysql://u:secret@h/d" });
    expect(invalid.success).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain("secret");
  });
});
