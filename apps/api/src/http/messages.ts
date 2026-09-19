/**
 * Client-facing messages shared by every endpoint. Endpoint-specific messages
 * live in their endpoint folder.
 *
 * @module
 */

export const MESSAGES = Object.freeze({
  invalidBody: "The request body is invalid.",
  malformedJson: "The request body is not valid JSON.",
  unsupportedContentType: "The request body must be JSON sent with Content-Type: application/json.",
  notFound: "No route matches this method and path.",
  internal: "An unexpected error occurred. The request may be retried.",
});
