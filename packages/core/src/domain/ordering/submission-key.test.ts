import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { SUBMISSION_KEY_MAX_LENGTH, submissionKeySchema } from "./submission-key";

/** The path and code of every issue, so assertions pin which check failed. */
const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.error?.issues.map(({ path, code }) => ({ path, code })) ?? [];

describe("submissionKeySchema", () => {
  test.each([
    "a",
    "0b8f6a2e-5c1d-4f7e-9a3b-2d6c8e1f4a70",
    "key with inner spaces",
    "x".repeat(SUBMISSION_KEY_MAX_LENGTH),
  ])("accepts %j verbatim", (key) => {
    expect(submissionKeySchema.safeParse(key)).toStrictEqual({ success: true, data: key });
  });

  test("the maximum length matches the submission_key column (255)", () => {
    expect(SUBMISSION_KEY_MAX_LENGTH).toBe(255);
  });

  test("rejects a blank key", () => {
    expect(issuesOf(submissionKeySchema.safeParse(""))).toStrictEqual([
      { path: [], code: "too_small" },
    ]);
  });

  test.each([" ", "   ", "\t", "\n", " \t\r\n "])("rejects whitespace-only key %j", (key) => {
    expect(issuesOf(submissionKeySchema.safeParse(key))).toStrictEqual([
      { path: [], code: "custom" },
    ]);
  });

  test.each([" key", "key ", "\tkey", "key\n", " key "])(
    "rejects surrounding whitespace in %j instead of trimming it",
    (key) => {
      const result = submissionKeySchema.safeParse(key);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        "Submission key must not have leading or trailing whitespace.",
      );
    },
  );

  test("rejects a key longer than 255 characters", () => {
    expect(
      issuesOf(submissionKeySchema.safeParse("x".repeat(SUBMISSION_KEY_MAX_LENGTH + 1))),
    ).toStrictEqual([{ path: [], code: "too_big" }]);
  });

  test.each([undefined, null, 42, true, {}, ["key"]])("rejects non-string %j", (key) => {
    expect(issuesOf(submissionKeySchema.safeParse(key))).toStrictEqual([
      { path: [], code: "invalid_type" },
    ]);
  });
});
