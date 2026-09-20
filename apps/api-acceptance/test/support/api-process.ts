/**
 * Starting and stopping the built API as a real child process.
 *
 * This is the suite's only way to run the API. The process is
 * `apps/api/dist/node.js` — the artifact a deployment ships — started with an
 * explicit environment allowlist so a developer's own `DATABASE_URL` or stray
 * `OTEL_*` variables can never reach the server under test.
 *
 * Readiness is the server's own "listening" log record on stdout, not a
 * `/health` probe: a probe would record an extra trace and an extra request
 * log, which the telemetry acceptance tests then have to reason about. The
 * record carries the bound port as a typed `server.port` field, so `PORT=0`
 * gives every process an ephemeral port with no port-picking races.
 *
 * Both modes use this module. The shared server is started here by the global
 * setup, and tests that need a differently configured server (telemetry
 * exporting to a fake collector, an unreachable database, restart recovery)
 * start their own extra process from the same artifact.
 *
 * @module
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { apiBundle, apiDirectory } from "#test/support/environment";
import { type LogRecord, parseLogRecords } from "#test/support/logs";

/** How long a process has to report that it is listening. */
const READY_TIMEOUT_MS = 30_000;
/** How long a process has to exit after SIGTERM before it is killed. */
const STOP_TIMEOUT_MS = 10_000;

/** Anything the suite can send requests to. */
export interface ApiUnderTest {
  readonly baseUrl: string;
}

export interface ApiProcess extends ApiUnderTest {
  /** Everything the process wrote to stdout so far. */
  stdout(): string;
  /** Everything the process wrote to stderr so far. */
  stderr(): string;
  /** Every parsable JSON log record written to stdout so far. */
  records(): LogRecord[];
  /**
   * Stops the process: SIGTERM, then SIGKILL if it outstays
   * {@link STOP_TIMEOUT_MS}. Resolves with the exit code (or null when
   * killed by a signal). Calling it twice is safe.
   *
   * Shutdown flushes batched spans and metrics, so telemetry is asserted
   * after this resolves.
   */
  stop(): Promise<number | null>;
}

export interface SpawnApiOptions {
  /** The server's DATABASE_URL. It need not be reachable. */
  readonly databaseUrl: string;
  /** Extra environment variables, for example the OTLP exporter settings. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Every process this module started that has not exited, so a failing test
 * cannot leave a server listening. Swept by {@link stopAllApiProcesses}.
 */
const running = new Set<ChildProcess>();

function killSurvivors(): void {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  running.clear();
}

// A crashed run must not leave a listener behind. Node does not emit `exit`
// for a default-handled SIGINT, so Ctrl+C is covered by the child sharing this
// process group rather than by this handler.
process.on("exit", killSurvivors);

/** Stops every process still running. Call from an `afterAll` sweep. */
export async function stopAllApiProcesses(): Promise<void> {
  await Promise.all([...running].map((child) => stopChild(child)));
}

async function stopChild(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    running.delete(child);
    return child.exitCode;
  }
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  try {
    const [code] = await exited;
    return code;
  } finally {
    clearTimeout(timer);
    running.delete(child);
  }
}

/** The last lines of a process's output, for a failure message. */
function tail(text: string, lines = 40): string {
  return text.split("\n").slice(-lines).join("\n").trim();
}

function describeFailure(reason: string, stdout: string, stderr: string): Error {
  const parts = [reason];
  const out = tail(stdout);
  const err = tail(stderr);
  if (out !== "") {
    parts.push(`stdout:\n${out}`);
  }
  if (err !== "") {
    parts.push(`stderr:\n${err}`);
  }
  return new Error(parts.join("\n\n"));
}

/**
 * The listening record: the first stdout record carrying a numeric
 * `server.port`. Written by `startServer` before any request is served.
 */
function listeningPort(stdout: string): number | undefined {
  for (const record of parseLogRecords(stdout)) {
    const port = record["server.port"];
    if (typeof port === "number" && typeof record.msg === "string") {
      return port;
    }
  }
  return undefined;
}

/**
 * Starts the built API and resolves once it reports that it is listening.
 *
 * Rejects, rather than hanging, when the process exits first (the message
 * carries its exit status and output) or when it never reports a port within
 * {@link READY_TIMEOUT_MS}.
 */
export async function spawnApi({ databaseUrl, env = {} }: SpawnApiOptions): Promise<ApiProcess> {
  const child = spawn(process.execPath, [apiBundle], {
    cwd: apiDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    // An allowlist, never `...process.env`: the server under test is
    // configured by this suite alone.
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl, PORT: "0", ...env },
  });
  running.add(child);

  let stdout = "";
  let stderr = "";
  // Both pipes must be drained or a full pipe buffer stalls the child.
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const port = await new Promise<number>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearInterval(poll);
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      finish();
    };
    const check = () => {
      const found = listeningPort(stdout);
      if (found !== undefined) {
        settle(() => resolve(found));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      running.delete(child);
      settle(() =>
        reject(
          describeFailure(
            `The API process exited before it reported that it was listening (code ${String(code)}, signal ${String(signal)}).`,
            stdout,
            stderr,
          ),
        ),
      );
    };
    const onError = (error: Error) => {
      // Deliberately kept in `running`: spawn failed, so whether a process
      // exists at all is unknown and the sweep should still try to kill it.
      settle(() =>
        reject(
          describeFailure(`The API process failed to start: ${error.message}`, stdout, stderr),
        ),
      );
    };
    const poll = setInterval(check, 20);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      running.delete(child);
      settle(() =>
        reject(
          describeFailure(
            `The API process did not report that it was listening within ${READY_TIMEOUT_MS} ms.`,
            stdout,
            stderr,
          ),
        ),
      );
    }, READY_TIMEOUT_MS);
    child.once("exit", onExit);
    child.once("error", onError);
    check();
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stdout: () => stdout,
    stderr: () => stderr,
    records: () => parseLogRecords(stdout),
    stop: () => stopChild(child),
  };
}
