/**
 * The Workers logger against the shared log record contract, inside workerd,
 * with the Workers context manager registered as the Worker composition
 * registers it. The Worker logs through the runtime-neutral console JSON
 * logger with the Workers sink (`logRecord`: one `console.log` call per
 * record, logging the record object). The harness captures each
 * `console.log` call and hands the suite its JSON form.
 */

import { createConsoleJsonLogger } from "../../http/logger";
import { describeLoggerContract } from "../../testing/logger-contract.test-support";
import { ensureWorkersContextManager } from "./context";
import { logRecord } from "./sdk";

describeLoggerContract("Cloudflare Workers logger (console.log of the record)", () => {
  ensureWorkersContextManager();
  return {
    create: ({ level, base }) => {
      const writes: string[] = [];
      const write = (line: string) => {
        // oxlint-disable-next-line no-console -- capturing the Worker's log sink.
        const original = console.log;
        // oxlint-disable-next-line no-console -- capturing the Worker's log sink.
        console.log = (...values: unknown[]) => {
          writes.push(values.map((value) => JSON.stringify(value)).join(" "));
        };
        try {
          logRecord(line);
        } finally {
          // oxlint-disable-next-line no-console -- restoring the Worker's log sink.
          console.log = original;
        }
      };
      return { logger: createConsoleJsonLogger({ level, base, write }), writes: () => writes };
    },
  };
});
