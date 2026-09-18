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

export function runCli({
  title = process.env.PR_TITLE ?? "",
  log = console.log,
  logError = console.error,
  validate = validatePullRequestTitle,
} = {}) {
  try {
    validate(title);
    log("PR title follows the repository Conventional Commit format.");
    return 0;
  } catch (error) {
    logError(error instanceof Error ? error.message : expectedTitleFormat);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
