/**
 * Spies on the persistence adapter factories while keeping their real
 * behaviour, so composition tests can see what each composition builds. Use
 * from a test file:
 *
 *   vi.mock("@scos/persistence", async (importOriginal) =>
 *     (await import("#testing/persistence-spies.test-support")).spyOnFactories(
 *       await importOriginal(),
 *     ),
 *   );
 */

import type * as Persistence from "@scos/persistence";
import { type Mock, type MockedFunction, vi } from "vitest";

type PersistenceModule = typeof Persistence;

export function spyOnFactories(actual: PersistenceModule): PersistenceModule {
  return {
    ...actual,
    createDatabasePool: vi.fn(actual.createDatabasePool),
    createPrismaClient: vi.fn(actual.createPrismaClient),
    createPrismaInventoryReader: vi.fn(actual.createPrismaInventoryReader),
    createPrismaSubmissionStore: vi.fn(actual.createPrismaSubmissionStore),
  };
}

export interface FactorySpies {
  readonly spies: {
    readonly pool: MockedFunction<PersistenceModule["createDatabasePool"]>;
    readonly prisma: MockedFunction<PersistenceModule["createPrismaClient"]>;
    readonly inventoryReader: MockedFunction<PersistenceModule["createPrismaInventoryReader"]>;
    readonly submissionStore: MockedFunction<PersistenceModule["createPrismaSubmissionStore"]>;
  };
  calls(): Record<string, number>;
  watchNextPool(): () => Mock | undefined;
}

export function factorySpies(persistence: PersistenceModule): FactorySpies {
  const spies: FactorySpies["spies"] = {
    pool: vi.mocked(persistence.createDatabasePool),
    prisma: vi.mocked(persistence.createPrismaClient),
    inventoryReader: vi.mocked(persistence.createPrismaInventoryReader),
    submissionStore: vi.mocked(persistence.createPrismaSubmissionStore),
  };
  /** How many times each factory was called. */
  const calls = (): Record<string, number> =>
    Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]));

  /** Creates the next pool for real, with a spy on its `end`. */
  const watchNextPool = (): (() => Mock | undefined) => {
    const createPool = spies.pool.getMockImplementation();
    if (createPool === undefined) {
      throw new Error("createDatabasePool spy has no implementation");
    }
    let end: Mock | undefined;
    spies.pool.mockImplementationOnce((...args) => {
      const pool = createPool(...args);
      end = vi.spyOn(pool, "end") as unknown as Mock;
      return pool;
    });
    return () => end;
  };

  return { spies, calls, watchNextPool };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Nothing listens on port 1; building a composition must not connect.
export const unreachableDatabaseUrl = "postgresql://scos:secret@127.0.0.1:1/scos";
