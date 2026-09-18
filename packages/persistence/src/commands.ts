import { createDatabasePool } from "./database.js";
import { confirmDatabaseReset } from "./reset.js";
import { type SeedQueryable, seedWarehouses } from "./seed.js";

export interface SeedCommandDependencies {
  readonly createPool: () => SeedQueryable & { end(): Promise<void> };
  readonly log: (message: string) => void;
}

/** `db:seed`: inserts missing seed warehouses and ends its own pool. */
export async function runSeedCommand(
  dependencies: SeedCommandDependencies = { createPool: createDatabasePool, log: console.log },
): Promise<void> {
  const pool = dependencies.createPool();
  try {
    const { inserted, existing } = await seedWarehouses(pool);
    dependencies.log(
      `Seeded warehouses: ${inserted} inserted, ${existing} already present (stock unchanged).`,
    );
  } finally {
    await pool.end();
  }
}

/** First step of `db:reset`: refuses unless the target database is confirmed. */
export function runConfirmResetCommand(
  environment: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): void {
  const databaseName = confirmDatabaseReset(environment);
  log(`Confirmed destructive reset of database "${databaseName}".`);
}
