import { expect, test } from "vitest";

import {
  isValidPullRequestTitle,
  runCli,
  validatePullRequestTitle,
} from "#scripts/validate-pr-title.mjs";

const allowedTypes = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

test("accepts every configured type", () => {
  for (const type of allowedTypes) {
    expect(isValidPullRequestTitle(`${type}: describe the change`), type).toBe(true);
  }
});

test("accepts scopes and breaking-change markers", () => {
  expect(isValidPullRequestTitle("feat(api): add order verification")).toBe(true);
  expect(isValidPullRequestTitle("feat(Order API): add order verification")).toBe(true);
  expect(isValidPullRequestTitle("feat(@platform/core): add order verification")).toBe(true);
  expect(isValidPullRequestTitle("feat(api)!: change submission contract")).toBe(true);
  expect(isValidPullRequestTitle("fix!: prevent duplicate orders")).toBe(true);
});

test("accepts shell-like text as inert description data", () => {
  expect(isValidPullRequestTitle("ci: preserve $(echo data); `touch nothing`")).toBe(true);
});

test("rejects disallowed types and malformed separators", () => {
  expect(isValidPullRequestTitle("feature: add verification")).toBe(false);
  expect(isValidPullRequestTitle("feat:add verification")).toBe(false);
  expect(isValidPullRequestTitle("feat : add verification")).toBe(false);
});

test("rejects empty or malformed scopes", () => {
  expect(isValidPullRequestTitle("feat(): add verification")).toBe(false);
  expect(isValidPullRequestTitle("feat(   ): add verification")).toBe(false);
  expect(isValidPullRequestTitle("feat(api: add verification")).toBe(false);
  expect(isValidPullRequestTitle("feat(api)): add verification")).toBe(false);
});

test("rejects missing, blank, or multiline descriptions", () => {
  expect(isValidPullRequestTitle("feat: ")).toBe(false);
  expect(isValidPullRequestTitle("feat:    ")).toBe(false);
  expect(isValidPullRequestTitle("feat: first line\nsecond line")).toBe(false);
  expect(isValidPullRequestTitle("feat: first line\r\nsecond line")).toBe(false);
});

test("the throwing validator accepts valid titles and explains invalid ones", () => {
  expect(() => validatePullRequestTitle("fix: prevent duplicate orders")).not.toThrow();
  expect(() => validatePullRequestTitle("feature: invalid type")).toThrow(
    /Expected Conventional Commit PR title/,
  );
});

test("the CLI runner reports valid and invalid titles without exiting directly", () => {
  const messages = [];
  const errors = [];

  expect(
    runCli({ title: "docs: explain validation", log: (message) => messages.push(message) }),
  ).toBe(0);
  expect(messages).toStrictEqual(["PR title follows the repository Conventional Commit format."]);

  expect(runCli({ title: "invalid", logError: (message) => errors.push(message) })).toBe(1);
  expect(errors[0]).toMatch(/Expected Conventional Commit PR title/);
});

test("the CLI runner reads PR_TITLE when no title option is supplied", () => {
  const previousTitle = process.env.PR_TITLE;
  const messages = [];
  process.env.PR_TITLE = "chore: use environment title";

  try {
    expect(runCli({ log: (message) => messages.push(message) })).toBe(0);
    expect(messages.length).toBe(1);
  } finally {
    if (previousTitle === undefined) {
      delete process.env.PR_TITLE;
    } else {
      process.env.PR_TITLE = previousTitle;
    }
  }
});

test("the CLI runner gives format guidance for unexpected validation failures", () => {
  const errors = [];

  expect(
    runCli({
      title: "fix: valid shape",
      validate: () => {
        throw "unexpected failure";
      },
      logError: (message) => errors.push(message),
    }),
  ).toBe(1);
  expect(errors[0]).toMatch(/Expected Conventional Commit PR title/);
});
