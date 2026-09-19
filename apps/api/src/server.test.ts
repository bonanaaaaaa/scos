import { describe, expect, test, vi } from "vitest";

import type { ComposedApplication } from "./composition";
import { type ServerRuntime, main, nodeRuntime, startServer } from "./server";

function fakeRuntime(overrides: Partial<ServerRuntime> = {}) {
  const signals = new Map<string, () => void>();
  const composed = {
    app: { fetch: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as ComposedApplication & { close: ReturnType<typeof vi.fn> };
  const closeServer = vi.fn((callback?: (error?: Error) => void) => callback?.());
  const mocks = {
    serve: vi.fn((options: { port: number }, onListening: (info: { port: number }) => void) => {
      onListening({ port: options.port });
      return { close: closeServer };
    }),
    compose: vi.fn(() => composed),
    log: vi.fn(),
    logError: vi.fn(),
    exit: vi.fn(),
    onSignal: vi.fn((signal: string, handler: () => void) => {
      signals.set(signal, handler);
    }),
  } satisfies ServerRuntime;
  const runtime: ServerRuntime = { ...mocks, ...overrides };
  return { runtime, mocks, signals, composed, closeServer };
}

describe("main (in process)", () => {
  test("invalid configuration exits 1 before composing or listening", () => {
    const { runtime, mocks } = fakeRuntime();

    expect(main({ PORT: "abc" }, runtime)).toBeUndefined();

    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.serve).not.toHaveBeenCalled();
    expect(mocks.logError.mock.calls.map(([message]) => message)).toStrictEqual([
      "SCOS API not started: invalid configuration.",
      "  DATABASE_URL: is required",
      "  PORT: must be an integer between 0 and 65535",
    ]);
  });

  test("valid configuration composes over DATABASE_URL and listens on PORT", () => {
    const { runtime, mocks, composed } = fakeRuntime();

    const running = main({ DATABASE_URL: "postgresql://h/db", PORT: "4321" }, runtime);

    expect(running?.config).toStrictEqual({ databaseUrl: "postgresql://h/db", port: 4321 });
    expect(mocks.compose).toHaveBeenCalledExactlyOnceWith({ databaseUrl: "postgresql://h/db" });
    expect(mocks.serve.mock.calls[0]?.[0]).toStrictEqual({ fetch: composed.app.fetch, port: 4321 });
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith(
      "SCOS API listening on http://localhost:4321",
    );
    expect(mocks.onSignal.mock.calls.map(([signal]) => signal)).toStrictEqual([
      "SIGINT",
      "SIGTERM",
    ]);
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  test("a signal closes the listener, then the database clients, then exits 0", async () => {
    const { runtime, mocks, signals, composed, closeServer } = fakeRuntime();
    main({ DATABASE_URL: "postgresql://h/db" }, runtime);

    signals.get("SIGTERM")?.();
    signals.get("SIGINT")?.();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));

    expect(closeServer).toHaveBeenCalledOnce();
    expect(composed.close).toHaveBeenCalledOnce();
    expect(closeServer.mock.invocationCallOrder[0]).toBeLessThan(
      composed.close.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("a failed shutdown still closes the clients and exits 1", async () => {
    const failure = new Error("close failed");
    const { runtime, mocks, signals, composed } = fakeRuntime({
      serve: (_options, onListening) => {
        onListening({ port: 1 });
        return { close: (callback) => callback?.(failure) };
      },
    });
    main({ DATABASE_URL: "postgresql://h/db" }, runtime);

    signals.get("SIGINT")?.();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));

    expect(composed.close).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith("SCOS API shutdown failed.", failure);
  });

  test("startServer can be used without main", async () => {
    const { runtime, composed } = fakeRuntime();
    const running = startServer({ databaseUrl: "postgresql://h/db", port: 0 }, runtime);

    await running.shutdown();
    await running.shutdown();
    expect(composed.close).toHaveBeenCalledOnce();
  });

  test("the node runtime logs to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      nodeRuntime.log("hello");
      nodeRuntime.logError("plain");
      nodeRuntime.logError("with cause", "cause");
      expect(log).toHaveBeenCalledWith("hello");
      expect(error.mock.calls).toStrictEqual([["plain"], ["with cause", "cause"]]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
