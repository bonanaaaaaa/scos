import assert from "node:assert/strict";
import test from "node:test";

import { isValidPullRequestTitle } from "./validate-pr-title.mjs";

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
