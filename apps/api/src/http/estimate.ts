/**
 * The Order Estimate response shape and its serializer. Shared because
 * verification returns it (200) and a rejected submission includes it (422).
 *
 * @module
 */

import type { Destination, OrderEstimate } from "@scos/core";
import { z } from "zod";

import {
  destinationResponseSchema,
  discountRateSchema,
  moneySchema,
  responseQuantitySchema,
  warehouseIdSchema,
} from "./schemas";

export const estimateAllocationSchema = z
  .object({
    warehouseId: warehouseIdSchema,
    quantity: responseQuantitySchema,
    /** Great-circle distance from the warehouse to the destination, unrounded. */
    distanceKm: z.number().nonnegative(),
  })
  .meta({
    id: "EstimateAllocation",
    description:
      "Units taken from one warehouse, nearest first, with the unrounded great-circle distance in km used to price shipping.",
  });

const estimateBaseShape = {
  quantity: responseQuantitySchema,
  destination: destinationResponseSchema,
  merchandiseSubtotal: moneySchema,
  discountRate: discountRateSchema,
  discountAmount: moneySchema,
  discountedMerchandiseTotal: moneySchema,
};

export const validEstimateSchema = z
  .object({
    valid: z.literal(true),
    reason: z.null(),
    ...estimateBaseShape,
    shippingCost: moneySchema,
    orderTotal: moneySchema,
    allocations: z.array(estimateAllocationSchema).min(1),
  })
  .meta({
    id: "ValidEstimate",
    description: "The Order can be fulfilled from current stock within the shipping limit.",
  });

export const shippingExceedsLimitEstimateSchema = z
  .object({
    valid: z.literal(false),
    reason: z.literal("SHIPPING_EXCEEDS_LIMIT"),
    ...estimateBaseShape,
    shippingCost: moneySchema,
    orderTotal: moneySchema,
    allocations: z.array(estimateAllocationSchema).min(1),
  })
  .meta({
    id: "ShippingExceedsLimitEstimate",
    description:
      "Shipping exceeds 15% of the discounted merchandise total. Every amount and allocation is kept.",
  });

export const insufficientStockEstimateSchema = z
  .object({
    valid: z.literal(false),
    reason: z.literal("INSUFFICIENT_STOCK"),
    ...estimateBaseShape,
    shippingCost: z.null(),
    orderTotal: z.null(),
    allocations: z.array(estimateAllocationSchema).max(0),
  })
  .meta({
    id: "InsufficientStockEstimate",
    description:
      "All warehouses together cannot supply the quantity. Merchandise and discount amounts are kept; `shippingCost` and `orderTotal` are null and `allocations` is empty.",
  });

/** Any Order Estimate: valid, or one of the two business rejections. */
export const estimateResponseSchema = z
  .union([validEstimateSchema, shippingExceedsLimitEstimateSchema, insufficientStockEstimateSchema])
  .meta({
    id: "OrderEstimate",
    description:
      "An advisory Order Estimate: valid, or one of the two business rejections (see `reason`).",
  });

export type EstimateResponse = z.output<typeof estimateResponseSchema>;
export type RejectedEstimate =
  | z.output<typeof shippingExceedsLimitEstimateSchema>
  | z.output<typeof insufficientStockEstimateSchema>;

export function destinationBody(destination: Destination) {
  return { latitude: destination.latitude, longitude: destination.longitude };
}

/**
 * Maps a core estimate to its response body. Every field is copied explicitly:
 * money becomes its two-decimal string and nullability is preserved.
 */
export function estimateBody(estimate: OrderEstimate): EstimateResponse {
  const base = {
    quantity: estimate.quantity,
    destination: destinationBody(estimate.destination),
    merchandiseSubtotal: estimate.merchandiseSubtotal.toString(),
    discountRate: estimate.discountRate,
    discountAmount: estimate.discountAmount.toString(),
    discountedMerchandiseTotal: estimate.discountedMerchandiseTotal.toString(),
  };
  if (estimate.reason === "INSUFFICIENT_STOCK") {
    return {
      valid: false,
      reason: estimate.reason,
      ...base,
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    };
  }
  const priced = {
    ...base,
    shippingCost: estimate.shippingCost.toString(),
    orderTotal: estimate.orderTotal.toString(),
    allocations: estimate.allocations.map(({ warehouseId, quantity, distanceKm }) => ({
      warehouseId,
      quantity,
      distanceKm,
    })),
  };
  return estimate.valid
    ? { valid: true, reason: null, ...priced }
    : { valid: false, reason: estimate.reason, ...priced };
}
