import assert from "node:assert/strict";
import { test } from "vitest";

import { isValidPullRequestTitle, runCli, validatePullRequestTitle } from "./validate-pr-title.mjs";

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
    assert.equal(isValidPullRequestTitle(`${type}: describe the change`), true, type);
  }
});

test("accepts scopes and breaking-change markers", () => {
  assert.equal(isValidPullRequestTitle("feat(api): add order verification"), true);
  assert.equal(isValidPullRequestTitle("feat(Order API): add order verification"), true);
  assert.equal(isValidPullRequestTitle("feat(@platform/core): add order verification"), true);
  assert.equal(isValidPullRequestTitle("feat(api)!: change submission contract"), true);
  assert.equal(isValidPullRequestTitle("fix!: prevent duplicate orders"), true);
});

test("accepts shell-like text as inert description data", () => {
  assert.equal(isValidPullRequestTitle("ci: preserve $(echo data); `touch nothing`"), true);
});

test("rejects disallowed types and malformed separators", () => {
  assert.equal(isValidPullRequestTitle("feature: add verification"), false);
  assert.equal(isValidPullRequestTitle("feat:add verification"), false);
  assert.equal(isValidPullRequestTitle("feat : add verification"), false);
});

test("rejects empty or malformed scopes", () => {
  assert.equal(isValidPullRequestTitle("feat(): add verification"), false);
  assert.equal(isValidPullRequestTitle("feat(   ): add verification"), false);
  assert.equal(isValidPullRequestTitle("feat(api: add verification"), false);
  assert.equal(isValidPullRequestTitle("feat(api)): add verification"), false);
});

test("rejects missing, blank, or multiline descriptions", () => {
  assert.equal(isValidPullRequestTitle("feat: "), false);
  assert.equal(isValidPullRequestTitle("feat:    "), false);
  assert.equal(isValidPullRequestTitle("feat: first line\nsecond line"), false);
  assert.equal(isValidPullRequestTitle("feat: first line\r\nsecond line"), false);
});

test("the throwing validator accepts valid titles and explains invalid ones", () => {
  assert.doesNotThrow(() => validatePullRequestTitle("fix: prevent duplicate orders"));
  assert.throws(
    () => validatePullRequestTitle("feature: invalid type"),
    /Expected Conventional Commit PR title/,
  );
});

test("the CLI runner reports valid and invalid titles without exiting directly", () => {
  const messages = [];
  const errors = [];

  assert.equal(
    runCli({ title: "docs: explain validation", log: (message) => messages.push(message) }),
    0,
  );
  assert.deepEqual(messages, ["PR title follows the repository Conventional Commit format."]);

  assert.equal(runCli({ title: "invalid", logError: (message) => errors.push(message) }), 1);
  assert.match(errors[0], /Expected Conventional Commit PR title/);
});

test("the CLI runner reads PR_TITLE when no title option is supplied", () => {
  const previousTitle = process.env.PR_TITLE;
  const messages = [];
  process.env.PR_TITLE = "chore: use environment title";

  try {
    assert.equal(runCli({ log: (message) => messages.push(message) }), 0);
    assert.equal(messages.length, 1);
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

  assert.equal(
    runCli({
      title: "fix: valid shape",
      validate: () => {
        throw "unexpected failure";
      },
      logError: (message) => errors.push(message),
    }),
    1,
  );
  assert.match(errors[0], /Expected Conventional Commit PR title/);
});
