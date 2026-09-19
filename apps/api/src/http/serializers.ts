/**
 * Maps core results to the HTTP response bodies in `contracts.ts`.
 *
 * Every field is copied explicitly: money becomes its two-decimal string,
 * nullability is preserved, and internal fields (the Order's database id,
 * brands) never leak into a response.
 *
 * @module
 */

import type { Destination, Order, OrderEstimate, RejectedSubmission } from "@scos/core";

import type { OrderResponse, RejectedEstimate, VerifyOrderResponse } from "./contracts";

function destinationBody(destination: Destination) {
  return { latitude: destination.latitude, longitude: destination.longitude };
}

export function estimateBody(estimate: OrderEstimate): VerifyOrderResponse {
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

export function rejectedEstimateBody(estimate: RejectedSubmission["estimate"]): RejectedEstimate {
  return estimateBody(estimate) as RejectedEstimate;
}

export function orderBody(order: Order): OrderResponse {
  return {
    orderNumber: order.orderNumber,
    submissionId: order.submissionKey,
    quantity: order.quantity,
    destination: destinationBody(order.destination),
    unitPrice: order.unitPrice.toString(),
    merchandiseSubtotal: order.merchandiseSubtotal.toString(),
    discountRate: order.discountRate,
    discountAmount: order.discountAmount.toString(),
    discountedMerchandiseTotal: order.discountedMerchandiseTotal.toString(),
    shippingCost: order.shippingCost.toString(),
    orderTotal: order.orderTotal.toString(),
    allocations: order.allocations.map(({ warehouseId, quantity }) => ({ warehouseId, quantity })),
  };
}
