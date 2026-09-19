/**
 * Server-side sink for unexpected errors, shared by every endpoint app. Never
 * sent to the client.
 *
 * @module
 */

export interface Logger {
  error(message: string, details: Readonly<Record<string, unknown>>): void;
}

export const consoleLogger: Logger = {
  error(message, details) {
    console.error(message, details);
  },
};
