import { pathToFileURL } from "node:url";

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

const scope = String.raw`(?:\([^\s()\r\n!:](?:[^()\r\n!:]*[^\s()\r\n!:])?\))?`;
const titlePattern = new RegExp(String.raw`^(?:${allowedTypes.join("|")})${scope}!?: \S[^\r\n]*$`);

export const expectedTitleFormat =
  "Expected Conventional Commit PR title: <type>(optional-scope)!: nonempty description. " +
  `Allowed types: ${allowedTypes.join(", ")}.`;

export function isValidPullRequestTitle(title) {
  return titlePattern.test(title);
}

export function validatePullRequestTitle(title) {
  if (!isValidPullRequestTitle(title)) {
    throw new Error(`${expectedTitleFormat}\nReceived title does not match the required format.`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validatePullRequestTitle(process.env.PR_TITLE ?? "");
    console.log("PR title follows the repository Conventional Commit format.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : expectedTitleFormat);
    process.exitCode = 1;
  }
}
