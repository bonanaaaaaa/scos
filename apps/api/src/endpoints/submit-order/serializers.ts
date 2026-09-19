/**
 * Maps SubmitOrder results to `POST /api/v1/orders` response bodies. Every field is
 * copied explicitly: money becomes its two-decimal string and internal fields
 * (the Order's database id, brands) never leak into a response.
 *
 * @module
 */

import type { Order, RejectedSubmission } from "@scos/core";

import { type RejectedEstimate, destinationBody, estimateBody } from "../../http/estimate";
import type { OrderResponse } from "./contract";

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
