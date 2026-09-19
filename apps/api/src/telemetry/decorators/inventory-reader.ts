/**
 * Traces the InventoryReader port (the verification read).
 *
 * @module
 */

import type { InventoryReader } from "@scos/core";

import type { Telemetry } from "../telemetry";
import { ATTR_WAREHOUSE_COUNT, inSpan } from "./span";

export function traceInventoryReader(
  reader: InventoryReader,
  telemetry: Telemetry,
): InventoryReader {
  return {
    readInventorySnapshot: () =>
      inSpan(telemetry, "InventoryReader.readInventorySnapshot", async (span) => {
        const snapshot = await reader.readInventorySnapshot();
        span.setAttribute(ATTR_WAREHOUSE_COUNT, snapshot.length);
        return snapshot;
      }),
  };
}
