/**
 * Composition of `POST /api/v1/orders/verify` alone: pool -> Prisma -> inventory
 * reader -> VerifyOrder -> app. No submission store is built.
 *
 * @module
 */

import { type VerifyOrder, createVerifyOrder } from "@scos/core";
import { type PrismaClient, createPrismaInventoryReader } from "@scos/persistence";

import {
  type ComposedApplication,
  type DatabaseCompositionOptions,
  composeOverDatabase,
  withLogger,
} from "#composition/database";
import { traceInventoryReader } from "#telemetry/decorators/inventory-reader";
import { traceVerifyOrder } from "#telemetry/decorators/verify-order";
import type { Telemetry } from "#telemetry/telemetry";
import { createVerifyOrderApp } from "#endpoints/verify-order/app";

export type VerifyOrderCompositionOptions = DatabaseCompositionOptions;

export function buildVerifyOrder(prisma: PrismaClient, telemetry?: Telemetry): VerifyOrder {
  const reader = createPrismaInventoryReader(prisma);
  if (telemetry === undefined) {
    return createVerifyOrder({ inventoryReader: reader });
  }
  return traceVerifyOrder(
    createVerifyOrder({ inventoryReader: traceInventoryReader(reader, telemetry) }),
    telemetry,
  );
}

export function composeVerifyOrderApplication(
  options: VerifyOrderCompositionOptions,
): ComposedApplication {
  return composeOverDatabase(options, (prisma) =>
    createVerifyOrderApp({
      verifyOrder: buildVerifyOrder(prisma, options.telemetry),
      ...withLogger(options.logger),
    }),
  );
}
