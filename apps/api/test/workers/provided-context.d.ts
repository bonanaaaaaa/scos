// The database URL global-setup.ts provides to the Workers integration
// project (vitest.workers.integration.config.mjs).
declare module "vitest" {
  export interface ProvidedContext {
    workerDatabaseUrl: string;
  }
}

export {};
