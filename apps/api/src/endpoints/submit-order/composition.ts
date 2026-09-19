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
} from "../../composition/database";
import { traceSubmissionStore } from "../../telemetry/decorators/submission-store";
import { traceSubmitOrder } from "../../telemetry/decorators/submit-order";
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
  const { telemetry } = options;
  const realStore = createPrismaSubmissionStore(prisma, options.submissionStore);
  const decorated = options.decorateSubmissionStore?.(realStore) ?? realStore;
  const store = telemetry === undefined ? decorated : traceSubmissionStore(decorated, telemetry);
  const submitOrder = createSubmitOrder({
    store,
    ...(options.maxSubmissionAttempts === undefined
      ? {}
      : { maxAttempts: options.maxSubmissionAttempts }),
  });
  return telemetry === undefined ? submitOrder : traceSubmitOrder(submitOrder, telemetry);
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
