// The Lambda functions, one per endpoint: src/lambda/<name>.ts is bundled to
// dist/lambda/<name>/index.mjs and zipped to dist/lambda/<name>.zip.
export const LAMBDA_FUNCTIONS = ["health", "verify-order", "submit-order"];
