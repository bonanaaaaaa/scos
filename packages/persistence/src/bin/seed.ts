import { runSeedCommand } from "#commands";

try {
  await runSeedCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
