# SCOS Ordering

Ordering SCOS Station P1 Pro devices from warehouse stock for delivery to a destination.

## Language

**Destination**:
The delivery location specified by latitude and longitude.

**Warehouse Inventory**:
The quantity of devices currently available for new orders at a warehouse.

**Order Request**:
A requested quantity of devices and a delivery destination expressed as latitude and longitude.

**Order Estimate**:
An assessment of an order request using currently available stock, including its prices, shipping cost, and validity. It does not reserve inventory or guarantee acceptance at submission.
_Avoid_: Guaranteed quote, reservation

**Order**:
An accepted request with an order number and amounts determined at submission. Acceptance consumes the required warehouse stock in full.

**Merchandise Subtotal**:
The requested quantity multiplied by the device's unit price, before discounts and shipping.

**Volume Discount**:
The reduction applied to the entire merchandise subtotal using the highest quantity tier the order qualifies for. Splitting fulfillment across warehouses does not change the tier.

**Discounted Merchandise Total**:
The merchandise subtotal after the volume discount, excluding shipping. This is the basis for the 15% shipping-cost limit.

**Shipping Cost**:
The delivery charge for fulfilling the entire requested quantity from available warehouses.

**Order Total**:
The discounted merchandise total plus shipping cost.
_Avoid_: Total price (without specifying whether shipping is included)

**Insufficient Stock**:
A condition in which total available warehouse inventory cannot fulfill the requested quantity. Such a request cannot become an order; partial fulfillment is not offered.

**Warehouse Allocation**:
The quantity of devices assigned to a particular warehouse to fulfill an order request.

**Shipping Plan**:
A collection of warehouse allocations fulfilling the entire requested quantity at the lowest shipping cost under the challenge's distance-based rate.
