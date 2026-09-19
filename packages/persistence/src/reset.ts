import { readDatabaseUrl } from "./database";

export const resetConfirmationVariable = "SCOS_CONFIRM_DATABASE_RESET";

/**
 * Guards the destructive development/test reset. The caller must name the
 * exact target database in SCOS_CONFIRM_DATABASE_RESET; anything else refuses.
 * Returns the confirmed database name.
 */
export function confirmDatabaseReset(environment: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = readDatabaseUrl(environment);
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (databaseName.length === 0) {
    throw new Error("DATABASE_URL must name the database to reset");
  }
  const confirmation = environment[resetConfirmationVariable];
  if (confirmation !== databaseName) {
    throw new Error(
      `Refusing to reset database "${databaseName}". This drops all of its data. ` +
        `To confirm, rerun with ${resetConfirmationVariable}=${databaseName}.`,
    );
  }
  return databaseName;
}
