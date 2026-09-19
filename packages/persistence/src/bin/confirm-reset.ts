import { runConfirmResetCommand } from "../commands";

try {
  runConfirmResetCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
