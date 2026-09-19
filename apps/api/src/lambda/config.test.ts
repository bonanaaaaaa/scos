import { describe, expect, test } from "vitest";

import {
  DEFAULT_POSTGRES_PORT,
  parseLambdaDatabaseConfig,
  parseLambdaHealthConfig,
} from "./config";

const SECRET = "secret-password";
const passwordUrl = `postgresql://scos:${SECRET}@db.internal:5432/scos`;
const proxyHost = "scos.proxy-abcdefghijkl.ap-southeast-1.rds.amazonaws.com";
const iamUrl = `postgresql://scos_app@${proxyHost}/scos`;
const region = "ap-southeast-1";

function errorsOf(result: ReturnType<typeof parseLambdaDatabaseConfig>): readonly string[] {
  if (result.success) {
    throw new Error("expected a failure");
  }
  return result.errors;
}

describe("parseLambdaHealthConfig", () => {
  test("requires nothing and ignores every other variable", () => {
    expect(parseLambdaHealthConfig({})).toStrictEqual({ success: true, config: {} });
    expect(
      parseLambdaHealthConfig({ DATABASE_URL: "nonsense", DATABASE_AUTH_MODE: "bogus" }),
    ).toStrictEqual({ success: true, config: {} });
  });
});

describe("parseLambdaDatabaseConfig: password mode", () => {
  test("is the default and keeps DATABASE_URL as given", () => {
    for (const environment of [
      { DATABASE_URL: passwordUrl },
      { DATABASE_URL: passwordUrl, DATABASE_AUTH_MODE: "password" },
      // AWS_REGION is always set in Lambda; it is only checked for format.
      { DATABASE_URL: passwordUrl, AWS_REGION: region },
    ]) {
      expect(parseLambdaDatabaseConfig(environment)).toStrictEqual({
        success: true,
        config: { databaseUrl: passwordUrl, authentication: { mode: "password" } },
      });
    }
  });

  test("reuses the DATABASE_URL rules of the local server", () => {
    expect(errorsOf(parseLambdaDatabaseConfig({}))).toStrictEqual(["DATABASE_URL: is required"]);
    expect(errorsOf(parseLambdaDatabaseConfig({ DATABASE_URL: "" }))).toStrictEqual([
      "DATABASE_URL: is required",
    ]);
    expect(
      errorsOf(parseLambdaDatabaseConfig({ DATABASE_URL: `mysql://u:${SECRET}@h/d` })),
    ).toStrictEqual(["DATABASE_URL: must be a postgres:// or postgresql:// URL with a host"]);
  });

  test("accepts AWS Region codes with two- to four-letter prefixes", () => {
    for (const value of ["ap-southeast-1", "us-gov-west-1", "eusc-de-east-1"]) {
      expect(
        parseLambdaDatabaseConfig({ DATABASE_URL: passwordUrl, AWS_REGION: value }).success,
        value,
      ).toBe(true);
    }
  });

  test("rejects an unknown or empty DATABASE_AUTH_MODE and a malformed AWS_REGION", () => {
    for (const mode of ["", "IAM", "Password", "secrets", " iam"]) {
      expect(
        errorsOf(
          parseLambdaDatabaseConfig({ DATABASE_URL: passwordUrl, DATABASE_AUTH_MODE: mode }),
        ),
        mode,
      ).toStrictEqual(["DATABASE_AUTH_MODE: must be password or iam"]);
    }
    for (const value of ["", "Asia Pacific", "ap-southeast", "AP-SOUTHEAST-1", "abcde-west-1"]) {
      expect(
        errorsOf(parseLambdaDatabaseConfig({ DATABASE_URL: passwordUrl, AWS_REGION: value })),
        value,
      ).toStrictEqual(["AWS_REGION: must be an AWS Region code such as ap-southeast-1"]);
    }
  });
});

describe("parseLambdaDatabaseConfig: iam mode", () => {
  test("derives the proxy endpoint, user, database and region", () => {
    expect(
      parseLambdaDatabaseConfig({
        DATABASE_URL: iamUrl,
        DATABASE_AUTH_MODE: "iam",
        AWS_REGION: region,
      }),
    ).toStrictEqual({
      success: true,
      config: {
        databaseUrl: iamUrl,
        authentication: {
          mode: "iam",
          hostname: proxyHost,
          port: DEFAULT_POSTGRES_PORT,
          username: "scos_app",
          database: "scos",
          region,
        },
      },
    });
    expect(DEFAULT_POSTGRES_PORT).toBe(5432);
  });

  test("keeps an explicit port and decodes percent-encoded names", () => {
    const result = parseLambdaDatabaseConfig({
      DATABASE_URL: `postgres://app%40scos@${proxyHost}:6543/scos%20db`,
      DATABASE_AUTH_MODE: "iam",
      AWS_REGION: "us-gov-west-1",
    });
    expect(result).toMatchObject({
      success: true,
      config: {
        authentication: {
          port: 6543,
          username: "app@scos",
          database: "scos db",
          region: "us-gov-west-1",
        },
      },
    });
  });

  test("rejects a password in DATABASE_URL without echoing it", () => {
    const errors = errorsOf(
      parseLambdaDatabaseConfig({
        DATABASE_URL: `postgresql://scos_app:${SECRET}@${proxyHost}/scos`,
        DATABASE_AUTH_MODE: "iam",
        AWS_REGION: region,
      }),
    );
    expect(errors).toStrictEqual([
      "DATABASE_URL: must not include a password when DATABASE_AUTH_MODE is iam",
    ]);
    expect(errors.join("\n")).not.toContain(SECRET);
  });

  test("requires a user and a database, and forbids query parameters", () => {
    const parse = (url: string) =>
      errorsOf(
        parseLambdaDatabaseConfig({
          DATABASE_URL: url,
          DATABASE_AUTH_MODE: "iam",
          AWS_REGION: region,
        }),
      );
    expect(parse(`postgresql://${proxyHost}/scos`)).toStrictEqual([
      "DATABASE_URL: must include the database user when DATABASE_AUTH_MODE is iam",
    ]);
    expect(parse(`postgresql://scos_app@${proxyHost}`)).toStrictEqual([
      "DATABASE_URL: must include the database name when DATABASE_AUTH_MODE is iam",
    ]);
    for (const query of ["?sslmode=disable", "?sslmode=verify-full", "?ssl=false"]) {
      expect(parse(`${iamUrl}${query}`), query).toStrictEqual([
        "DATABASE_URL: must not include query parameters when DATABASE_AUTH_MODE is iam (TLS is enforced)",
      ]);
    }
    expect(parse(`postgresql://scos_app@${proxyHost}:0/scos`)).toStrictEqual([
      "DATABASE_URL: must not use port 0 when DATABASE_AUTH_MODE is iam",
    ]);
    for (const host of ["[::1]", "[2001:db8::1]:5432"]) {
      expect(parse(`postgresql://scos_app@${host}/scos`), host).toStrictEqual([
        "DATABASE_URL: must name the proxy by host name, not an IPv6 address, when DATABASE_AUTH_MODE is iam",
      ]);
    }
    expect(parse(`postgresql://bad%zzname@${proxyHost}/scos`)).toStrictEqual([
      "DATABASE_URL: must use valid percent-encoding",
    ]);
  });

  test("an unparseable URL is reported, never thrown, and never echoed", () => {
    for (const value of [
      `postgresql://scos_app:${SECRET}@/scos`,
      `postgresql://scos_app:${SECRET}@[bad/scos`,
      `not a url ${SECRET}`,
    ]) {
      let result: ReturnType<typeof parseLambdaDatabaseConfig> | undefined;
      expect(() => {
        result = parseLambdaDatabaseConfig({
          DATABASE_URL: value,
          DATABASE_AUTH_MODE: "iam",
          AWS_REGION: region,
        });
      }, value).not.toThrow();
      expect(result, value).toStrictEqual({
        success: false,
        errors: ["DATABASE_URL: must be a postgres:// or postgresql:// URL with a host"],
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  test("forbids a fragment", () => {
    expect(
      errorsOf(
        parseLambdaDatabaseConfig({
          DATABASE_URL: `${iamUrl}#${SECRET}`,
          DATABASE_AUTH_MODE: "iam",
          AWS_REGION: region,
        }),
      ),
    ).toStrictEqual(["DATABASE_URL: must not include a fragment when DATABASE_AUTH_MODE is iam"]);
  });

  test("requires AWS_REGION, and reports it alongside other problems", () => {
    expect(
      errorsOf(parseLambdaDatabaseConfig({ DATABASE_URL: iamUrl, DATABASE_AUTH_MODE: "iam" })),
    ).toStrictEqual(["AWS_REGION: is required when DATABASE_AUTH_MODE is iam"]);
    expect(errorsOf(parseLambdaDatabaseConfig({ DATABASE_AUTH_MODE: "iam" }))).toStrictEqual([
      "DATABASE_URL: is required",
      "AWS_REGION: is required when DATABASE_AUTH_MODE is iam",
    ]);
    const errors = errorsOf(
      parseLambdaDatabaseConfig({
        DATABASE_URL: `postgresql://scos_app:${SECRET}@${proxyHost}/scos?sslmode=disable`,
        DATABASE_AUTH_MODE: "iam",
      }),
    );
    expect(errors).toStrictEqual([
      "AWS_REGION: is required when DATABASE_AUTH_MODE is iam",
      "DATABASE_URL: must not include a password when DATABASE_AUTH_MODE is iam",
      "DATABASE_URL: must not include query parameters when DATABASE_AUTH_MODE is iam (TLS is enforced)",
    ]);
    for (const line of errors) {
      expect(line).toMatch(/^[A-Z_]+: [^\n]+$/);
      expect(line).not.toContain(SECRET);
    }
  });
});
