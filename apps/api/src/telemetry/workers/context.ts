/**
 * OpenTelemetry context propagation for Cloudflare Workers: a
 * `ContextManager` over `AsyncLocalStorage` from `node:async_hooks`, which
 * workerd provides with the `nodejs_compat` flag. Each request's context
 * follows its own async chain, so concurrent requests in one isolate never
 * see each other's active span.
 *
 * `@opentelemetry/context-async-hooks` is not used: it is part of the Node
 * composition and also patches `EventEmitter`s, which the Worker does not
 * need. This is the same `AsyncLocalStorage` technique without the Node-only
 * parts.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { type Context, type ContextManager, ROOT_CONTEXT, context } from "@opentelemetry/api";

export class WorkersContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    active: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(active, () => fn.apply(thisArg, args));
  }

  bind<T>(active: Context, target: T): T {
    if (typeof target !== "function") {
      return target;
    }
    const run = (thisArg: unknown, args: unknown[]) =>
      this.with(active, () => (target as (...values: unknown[]) => unknown).apply(thisArg, args));
    return function bound(this: unknown, ...args: unknown[]) {
      return run(this, args);
    } as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

let registered = false;

/**
 * Registers {@link WorkersContextManager} as the global context manager,
 * once per isolate. The HTTP middleware, the decorators and the logger's
 * trace correlation all read the active context through the global API.
 */
export function ensureWorkersContextManager(): void {
  if (!registered) {
    context.setGlobalContextManager(new WorkersContextManager().enable());
    registered = true;
  }
}
