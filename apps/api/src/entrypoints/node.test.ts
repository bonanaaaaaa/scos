import { describe, expect, test, vi } from "vitest";

import type { ComposedApplication } from "#composition/node";
import {
  TELEMETRY_SHUTDOWN_TIMEOUT_MS,
  type ServerRuntime,
  main,
  nodeRuntime,
  startServer,
} from "#entrypoints/node";
import type { StructuredLogger } from "#http/logger";
import type { TelemetryRuntime } from "#telemetry/node/sdk";
import { DEFAULT_TELEMETRY_CONFIG, testTelemetry } from "#testing/telemetry.test-support";

function fakeStructuredLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger as StructuredLogger),
  };
  return logger;
}

const defaultTelemetry = DEFAULT_TELEMETRY_CONFIG;

function fakeRuntime(overrides: Partial<ServerRuntime> = {}) {
  const signals = new Map<string, () => void>();
  const composed = {
    app: { fetch: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as ComposedApplication & { close: ReturnType<typeof vi.fn> };
  const closeServer = vi.fn((callback?: (error?: Error) => void) => callback?.());
  const logger = fakeStructuredLogger();
  const observability = {
    telemetry: testTelemetry().telemetry,
    logger,
    forceFlush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } satisfies TelemetryRuntime;
  const mocks = {
    serve: vi.fn((options: { port: number }, onListening: (info: { port: number }) => void) => {
      onListening({ port: options.port });
      return { close: closeServer };
    }),
    compose: vi.fn(() => composed),
    startTelemetry: vi.fn(() => observability),
    logError: vi.fn(),
    exit: vi.fn(),
    onSignal: vi.fn((signal: string, handler: () => void) => {
      signals.set(signal, handler);
    }),
  } satisfies ServerRuntime;
  const runtime: ServerRuntime = { ...mocks, ...overrides };
  return { runtime, mocks, signals, composed, closeServer, logger, observability };
}

describe("main (in process)", () => {
  test("invalid configuration exits 1 before composing or listening", () => {
    const { runtime, mocks } = fakeRuntime();

    expect(main({ PORT: "abc" }, runtime)).toBeUndefined();

    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.startTelemetry).not.toHaveBeenCalled();
    expect(mocks.serve).not.toHaveBeenCalled();
    expect(mocks.logError.mock.calls.map(([message]) => message)).toStrictEqual([
      "SCOS API not started: invalid configuration.",
      "  DATABASE_URL: is required",
      "  PORT: must be an integer between 0 and 65535",
    ]);
  });

  test("valid configuration composes over DATABASE_URL and listens on PORT", () => {
    const { runtime, mocks, composed, logger, observability } = fakeRuntime();

    const running = main({ DATABASE_URL: "postgresql://h/db", PORT: "4321" }, runtime);

    expect(running?.config).toStrictEqual({
      databaseUrl: "postgresql://h/db",
      port: 4321,
      telemetry: defaultTelemetry,
    });
    expect(mocks.startTelemetry).toHaveBeenCalledExactlyOnceWith(defaultTelemetry);
    // Telemetry starts before the app (and so any logger) is composed.
    expect(mocks.startTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.compose.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.compose).toHaveBeenCalledExactlyOnceWith({
      databaseUrl: "postgresql://h/db",
      logger,
      telemetry: observability.telemetry,
    });
    expect(mocks.serve.mock.calls[0]?.[0]).toStrictEqual({ fetch: composed.app.fetch, port: 4321 });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      "SCOS API listening on http://localhost:4321",
      { "server.port": 4321 },
    );
    expect(mocks.onSignal.mock.calls.map(([signal]) => signal)).toStrictEqual([
      "SIGINT",
      "SIGTERM",
    ]);
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  test("a signal closes the listener, the database clients, then flushes telemetry and exits 0", async () => {
    const { runtime, mocks, signals, composed, closeServer, observability } = fakeRuntime();
    main({ DATABASE_URL: "postgresql://h/db" }, runtime);

    signals.get("SIGTERM")?.();
    signals.get("SIGINT")?.();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));

    expect(closeServer).toHaveBeenCalledOnce();
    expect(composed.close).toHaveBeenCalledOnce();
    expect(closeServer.mock.invocationCallOrder[0]).toBeLessThan(
      composed.close.mock.invocationCallOrder[0] ?? 0,
    );
    expect(observability.shutdown).toHaveBeenCalledExactlyOnceWith(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
    expect(composed.close.mock.invocationCallOrder[0]).toBeLessThan(
      observability.shutdown.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("a failed shutdown still closes the clients and exits 1", async () => {
    const failure = new Error("close failed");
    const { runtime, mocks, signals, composed, logger, observability } = fakeRuntime({
      serve: (_options, onListening) => {
        onListening({ port: 1 });
        return { close: (callback) => callback?.(failure) };
      },
    });
    main({ DATABASE_URL: "postgresql://h/db" }, runtime);

    signals.get("SIGINT")?.();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));

    expect(composed.close).toHaveBeenCalledOnce();
    expect(observability.shutdown).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("SCOS API shutdown failed.", { error: failure });
  });

  test("startServer can be used without main", async () => {
    const { runtime, composed } = fakeRuntime();
    const running = startServer(
      { databaseUrl: "postgresql://h/db", port: 0, telemetry: defaultTelemetry },
      runtime,
    );

    await running.shutdown();
    await running.shutdown();
    expect(composed.close).toHaveBeenCalledOnce();
  });

  test("the node runtime prints configuration errors to stderr", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      nodeRuntime.logError("plain");
      expect(error.mock.calls).toStrictEqual([["plain"]]);
    } finally {
      error.mockRestore();
    }
  });
});
