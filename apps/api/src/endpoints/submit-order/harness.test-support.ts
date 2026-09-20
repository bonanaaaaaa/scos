/** A standalone submit app over a fake SubmitOrder and a fake logger. */

import type { SubmitOrder, SubmitOrderOutcome } from "@scos/core";
import { vi } from "vitest";

import { acceptedOrder, fakeLogger } from "#testing/fixtures.test-support";

import { createSubmitOrderApp } from "./app";

export function harness(
  submit: (input: unknown) => Promise<SubmitOrderOutcome> = async () => ({
    kind: "accepted",
    order: acceptedOrder,
    replayed: false,
  }),
) {
  const submitOrder = vi.fn<SubmitOrder>(submit);
  const logger = fakeLogger();
  return { app: createSubmitOrderApp({ submitOrder, logger }), submitOrder, logger };
}
