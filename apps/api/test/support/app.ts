/**
 * Builds the real composed application (the same wiring `entrypoints/node.ts` uses) over
 * a test database, and sends JSON requests through it.
 *
 * @module
 */

import type { SubmissionStore, SubmissionTransaction } from "@scos/core";

import {
  type ComposedApplication,
  type CompositionOptions,
  composeApplication,
} from "../../src/composition/node";

// Seeded warehouse IDs (packages/persistence/src/seed.ts), in lock order.
export const LOS_ANGELES = "01996000-0000-7000-8000-000000000001";
export const NEW_YORK = "01996000-0000-7000-8000-000000000002";
export const SAO_PAULO = "01996000-0000-7000-8000-000000000003";
export const PARIS = "01996000-0000-7000-8000-000000000004";
export const WARSAW = "01996000-0000-7000-8000-000000000005";
export const HONG_KONG = "01996000-0000-7000-8000-000000000006";

/** Paris warehouse coordinates: no shipping distance for Paris stock. */
export const AT_PARIS = { latitude: 49.009722, longitude: 2.547778 } as const;
/** South of New Zealand: every warehouse is > 9 000 km away. */
export const FAR_AWAY = { latitude: -45, longitude: 170 } as const;

export const silentLogger = { error: () => undefined };

/** Tracks composed applications so every test can close them. */
export class Applications {
  readonly #open: ComposedApplication[] = [];

  compose(
    databaseUrl: string,
    options: Omit<CompositionOptions, "databaseUrl"> = {},
  ): ComposedApplication {
    const composed = composeApplication({ databaseUrl, logger: silentLogger, ...options });
    this.#open.push(composed);
    return composed;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#open.splice(0).map((composed) => composed.close()));
  }
}

export function postJson(
  composed: ComposedApplication,
  path: "/api/v1/orders" | "/api/v1/orders/verify",
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    composed.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export interface ResponseSnapshot {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  json(): unknown;
}

/** Reads a response once so the status and exact body can be compared. */
export async function snapshot(response: Response | Promise<Response>): Promise<ResponseSnapshot> {
  const resolved = await response;
  const text = await resolved.text();
  return {
    status: resolved.status,
    text,
    headers: resolved.headers,
    json: () => JSON.parse(text) as unknown,
  };
}

export type FailureStage =
  | "afterLockInventory"
  | "afterFindOrderBySubmissionKey"
  | "afterSaveAcceptedOrder"
  | "afterCommit";

/**
 * Switches for {@link failureInjector}. Each armed switch fires once and then
 * disarms itself, so the same app can show that a retry succeeds.
 */
export interface FailureSwitches {
  failAt?: FailureStage;
  /** Hide the Order from this many unlocked lookups (then answer truthfully). */
  hideFromUnlockedLookups?: number;
  /** Hide the Order from every locked lookup while set. */
  hideFromLockedLookups?: boolean;
  /** Counts `runInTransaction` calls (transaction attempts). */
  attempts: number;
}

export class InjectedFailure extends Error {
  constructor(stage: FailureStage) {
    super(`Injected failure ${stage}`);
    this.name = "InjectedFailure";
  }
}

/** A store decorator for `decorateSubmissionStore` driven by `switches`. */
export function failureInjector(switches: FailureSwitches) {
  const fire = (stage: FailureStage) => {
    if (switches.failAt === stage) {
      delete switches.failAt;
      throw new InjectedFailure(stage);
    }
  };

  return (store: SubmissionStore): SubmissionStore => ({
    async findOrderBySubmissionKey(key) {
      if ((switches.hideFromUnlockedLookups ?? 0) > 0) {
        switches.hideFromUnlockedLookups = (switches.hideFromUnlockedLookups ?? 0) - 1;
        return null;
      }
      return store.findOrderBySubmissionKey(key);
    },
    async runInTransaction(work) {
      switches.attempts += 1;
      const result = await store.runInTransaction((tx) => {
        const decorated: SubmissionTransaction = {
          async lockInventory() {
            const inventory = await tx.lockInventory();
            fire("afterLockInventory");
            return inventory;
          },
          async findOrderBySubmissionKey(key) {
            const found = await tx.findOrderBySubmissionKey(key);
            fire("afterFindOrderBySubmissionKey");
            return switches.hideFromLockedLookups === true ? null : found;
          },
          async saveAcceptedOrder(order) {
            const saved = await tx.saveAcceptedOrder(order);
            fire("afterSaveAcceptedOrder");
            return saved;
          },
        };
        return work(decorated);
      });
      // Committed; the response is lost on its way back to the client.
      fire("afterCommit");
      return result;
    },
  });
}
