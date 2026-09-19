/**
 * Composition of `POST /api/v1/orders` alone: pool -> Prisma -> submission store ->
 * SubmitOrder -> app. No inventory reader is built.
 *
 * @module
 */

import { type SubmissionStore, type SubmitOrder, createSubmitOrder } from "@scos/core";
import {
  type PrismaClient,
  type PrismaSubmissionStoreOptions,
  createPrismaSubmissionStore,
} from "@scos/persistence";

import {
  type ComposedApplication,
  type DatabaseCompositionOptions,
  composeOverDatabase,
  withLogger,
} from "../../database";
import { createSubmitOrderApp } from "./app";

export interface SubmitOrderCompositionOptions extends DatabaseCompositionOptions {
  /** Transaction timeouts for submissions; persistence defaults apply otherwise. */
  readonly submissionStore?: PrismaSubmissionStoreOptions;
  /** Total SubmitOrder attempts for transient failures; core default otherwise. */
  readonly maxSubmissionAttempts?: number;
  /**
   * Wraps the real submission store. Tests use it to inject failures at a
   * given stage while every request still goes through the composed app.
   */
  readonly decorateSubmissionStore?: (store: SubmissionStore) => SubmissionStore;
}

export function buildSubmitOrder(
  prisma: PrismaClient,
  options: SubmitOrderCompositionOptions,
): SubmitOrder {
  const realStore = createPrismaSubmissionStore(prisma, options.submissionStore);
  const store = options.decorateSubmissionStore?.(realStore) ?? realStore;
  return createSubmitOrder({
    store,
    ...(options.maxSubmissionAttempts === undefined
      ? {}
      : { maxAttempts: options.maxSubmissionAttempts }),
  });
}

export function composeSubmitOrderApplication(
  options: SubmitOrderCompositionOptions,
): ComposedApplication {
  return composeOverDatabase(options, (prisma) =>
    createSubmitOrderApp({
      submitOrder: buildSubmitOrder(prisma, options),
      ...withLogger(options.logger),
    }),
  );
}
