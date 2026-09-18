-- Initial SCOS Ordering schema.
--
-- Table, index, and foreign-key DDL follows the output of
-- `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`.
-- The created_at/updated_at DEFAULT NOW() clauses are hand-written: the Prisma
-- schema declares them as @default(dbgenerated()) so the client never sends
-- its own clock value. The sections after the generated DDL are hand-written
-- because Prisma cannot express them: CHECK constraints and the shared
-- timestamp trigger function and per-table triggers (ADR 0003).
-- See docs/database-schema.md.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "stock" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_number" TEXT NOT NULL,
    "submission_key" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "destination_latitude" DOUBLE PRECISION NOT NULL,
    "destination_longitude" DOUBLE PRECISION NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "discount_rate" DECIMAL(3,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL,
    "shipping_cost" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_allocations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "order_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_name_key" ON "warehouses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_submission_key_key" ON "orders"("submission_key");

-- CreateIndex
CREATE INDEX "order_allocations_warehouse_id_idx" ON "order_allocations"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_allocations_order_id_warehouse_id_key" ON "order_allocations"("order_id", "warehouse_id");

-- AddForeignKey
ALTER TABLE "order_allocations" ADD CONSTRAINT "order_allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_allocations" ADD CONSTRAINT "order_allocations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- CHECK constraints (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

ALTER TABLE "warehouses"
    ADD CONSTRAINT "warehouses_name_check" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "warehouses_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
    ADD CONSTRAINT "warehouses_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
    ADD CONSTRAINT "warehouses_stock_check" CHECK ("stock" >= 0);

-- The client's duplicate-request key and the Order Request (quantity and
-- destination) are stored on the accepted Order itself; rejected requests are
-- not persisted, so they consume no key.
--
-- Only independent commercial facts are stored. The merchandise subtotal
-- (unit_price * quantity), the discounted merchandise total (subtotal -
-- discount_amount), and the order total (discounted total + shipping_cost) are
-- derived on read. These CHECKs keep every derived amount valid and storable
-- as NUMERIC(12,2): the discount cannot exceed the subtotal, so no derived
-- amount is negative, and the subtotal and order total cannot exceed
-- 9999999999.99 (the discounted total is bounded by the subtotal). The
-- expressions are evaluated in unbounded NUMERIC, so they are exact and cannot
-- overflow.
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_order_number_check" CHECK (btrim("order_number") <> ''),
    ADD CONSTRAINT "orders_submission_key_check"
        CHECK (btrim("submission_key") <> '' AND char_length("submission_key") <= 255),
    ADD CONSTRAINT "orders_quantity_check" CHECK ("quantity" > 0),
    ADD CONSTRAINT "orders_destination_latitude_check"
        CHECK ("destination_latitude" BETWEEN -90 AND 90),
    ADD CONSTRAINT "orders_destination_longitude_check"
        CHECK ("destination_longitude" BETWEEN -180 AND 180),
    ADD CONSTRAINT "orders_unit_price_check" CHECK ("unit_price" >= 0),
    ADD CONSTRAINT "orders_discount_rate_check" CHECK ("discount_rate" BETWEEN 0 AND 1),
    ADD CONSTRAINT "orders_discount_amount_check"
        CHECK ("discount_amount" >= 0 AND "discount_amount" <= "unit_price" * "quantity"),
    ADD CONSTRAINT "orders_shipping_cost_check" CHECK ("shipping_cost" >= 0),
    ADD CONSTRAINT "orders_merchandise_subtotal_range_check"
        CHECK ("unit_price" * "quantity" <= 9999999999.99),
    ADD CONSTRAINT "orders_order_total_range_check"
        CHECK ("unit_price" * "quantity" - "discount_amount" + "shipping_cost" <= 9999999999.99);

ALTER TABLE "order_allocations"
    ADD CONSTRAINT "order_allocations_quantity_check" CHECK ("quantity" > 0);

-- ---------------------------------------------------------------------------
-- Database-managed timestamps (ADR 0003)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_warehouses_updated_at ON "warehouses";
CREATE TRIGGER update_warehouses_updated_at
BEFORE UPDATE ON "warehouses"
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS update_orders_updated_at ON "orders";
CREATE TRIGGER update_orders_updated_at
BEFORE UPDATE ON "orders"
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS update_order_allocations_updated_at ON "order_allocations";
CREATE TRIGGER update_order_allocations_updated_at
BEFORE UPDATE ON "order_allocations"
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();
