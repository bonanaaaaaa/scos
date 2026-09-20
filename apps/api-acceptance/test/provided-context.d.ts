// What global-setup.ts provides to every acceptance test file. The global
// setup runs in the Vitest main process and test files run in workers, so
// `provide`/`inject` is the channel, not environment variables.
declare module "vitest" {
  export interface ProvidedContext {
    /** The served API every test calls: the shared server, or API_BASE_URL. */
    apiBaseUrl: string;
    /** The database that server uses; tests read and reset stock through it. */
    acceptanceDatabaseUrl: string;
    /** "shared" when this run started the server, "external" for API_BASE_URL. */
    acceptanceMode: "shared" | "external";
  }
}

export {};
