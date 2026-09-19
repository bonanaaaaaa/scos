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
} from "../../database";
import { createVerifyOrderApp } from "./app";

export type VerifyOrderCompositionOptions = DatabaseCompositionOptions;

export function buildVerifyOrder(prisma: PrismaClient): VerifyOrder {
  return createVerifyOrder({ inventoryReader: createPrismaInventoryReader(prisma) });
}

export function composeVerifyOrderApplication(
  options: VerifyOrderCompositionOptions,
): ComposedApplication {
  return composeOverDatabase(options, (prisma) =>
    createVerifyOrderApp({ verifyOrder: buildVerifyOrder(prisma), ...withLogger(options.logger) }),
  );
}
