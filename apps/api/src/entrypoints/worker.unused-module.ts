/**
 * Stands in for optional modules the Worker bundle must not carry (see
 * `alias` in wrangler.jsonc). hono-openapi's schema adapters lazily
 * `import()` the converter of every schema library they support; the API
 * uses Zod 4 only, which converts itself, so the `effect` adapter never runs.
 * Without this alias Wrangler would bundle `effect` and `fast-check`
 * (about 2.8 MB of the 5 MB script). The Node build leaves the same modules
 * external for the same reason (build.mjs).
 *
 * @module
 */

throw new Error("This optional module is not bundled in the SCOS Worker.");
