import { runConfirmResetCommand } from "../commands.js";

try {
  runConfirmResetCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
