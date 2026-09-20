/**
 * HTTP helpers for the black-box API acceptance tests.
 *
 * Every request goes out over `fetch` against a base URL, so the suite talks
 * to the API exactly as a client would: no in-process app, no imports from
 * the implementation. The assertions here cover the transport contract the
 * whole suite relies on — JSON media type and the documented error envelope.
 *
 * @module
 */

import { expect } from "vitest";

/** Anything the suite can send requests to: the shared served API or an extra process. */
export interface ApiUnderTest {
  readonly baseUrl: string;
}

export interface HttpResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Headers;
  readonly text: string;
  json(): unknown;
}

export interface RawRequest {
  readonly method?: string;
  /** A string is sent as-is; a Uint8Array is sent with no implicit Content-Type. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  /** `null` sends no Content-Type header at all. Defaults to application/json. */
  readonly contentType?: string | null;
  /** Extra request headers, for example a W3C `traceparent`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export async function request(
  api: ApiUnderTest,
  path: string,
  { method = "POST", body, contentType = "application/json", headers: extra = {} }: RawRequest = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...extra };
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(`${api.baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    headers: response.headers,
    text,
    json: () => JSON.parse(text) as unknown,
  };
}

export function postJson(api: ApiUnderTest, path: string, body: unknown): Promise<HttpResult> {
  return request(api, path, { body: JSON.stringify(body) });
}

export function get(api: ApiUnderTest, path: string): Promise<HttpResult> {
  return request(api, path, { method: "GET", contentType: null });
}

/** Every response body is JSON sent as application/json. */
export function expectJson(result: HttpResult, status: number): unknown {
  expect(result.status, result.text).toBe(status);
  expect(result.contentType).toMatch(/^application\/json(\s*;\s*charset=utf-8)?$/i);
  return result.json();
}

/** The documented error envelope, exactly: `{ error: { code, message[, issues] } }`. */
export function expectErrorEnvelope(
  result: HttpResult,
  status: number,
  code: string,
  { issues }: { issues: "present" | "absent" | "any" } = { issues: "any" },
): { code: string; message: string; issues?: { path: (string | number)[]; message: string }[] } {
  const body = expectJson(result, status) as { error: Record<string, unknown> };
  expect(Object.keys(body)).toStrictEqual(["error"]);
  const error = body.error;
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe("string");
  expect(error.message).not.toBe("");
  const keys = Object.keys(error).sort();
  if (issues === "present") {
    expect(keys).toStrictEqual(["code", "issues", "message"]);
  } else if (issues === "absent") {
    expect(keys).toStrictEqual(["code", "message"]);
  } else {
    expect(["code,message", "code,issues,message"]).toContain(keys.join(","));
  }
  if (error.issues !== undefined) {
    expect(Array.isArray(error.issues)).toBe(true);
    expect((error.issues as unknown[]).length).toBeGreaterThan(0);
    for (const issue of error.issues as Record<string, unknown>[]) {
      expect(Object.keys(issue).sort()).toStrictEqual(["message", "path"]);
      expect(Array.isArray(issue.path)).toBe(true);
      for (const segment of issue.path as unknown[]) {
        expect(["string", "number"]).toContain(typeof segment);
      }
      expect(typeof issue.message).toBe("string");
    }
  }
  return error as never;
}
