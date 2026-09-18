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
CREATE TABLE "warehouse" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "stock" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_order" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_number" TEXT NOT NULL,
    "submission_key" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "destination_latitude" DOUBLE PRECISION NOT NULL,
    "destination_longitude" DOUBLE PRECISION NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "merchandise_subtotal" DECIMAL(12,2) NOT NULL,
    "discount_rate" DECIMAL(3,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL,
    "discounted_merchandise_total" DECIMAL(12,2) NOT NULL,
    "shipping_cost" DECIMAL(12,2) NOT NULL,
    "order_total" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "customer_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_allocation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "order_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_name_key" ON "warehouse"("name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_order_number_key" ON "customer_order"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_submission_key_key" ON "customer_order"("submission_key");

-- CreateIndex
CREATE INDEX "order_allocation_warehouse_id_idx" ON "order_allocation"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_allocation_order_id_warehouse_id_key" ON "order_allocation"("order_id", "warehouse_id");

-- AddForeignKey
ALTER TABLE "order_allocation" ADD CONSTRAINT "order_allocation_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_allocation" ADD CONSTRAINT "order_allocation_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- CHECK constraints (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

ALTER TABLE "warehouse"
    ADD CONSTRAINT "warehouse_name_check" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "warehouse_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
    ADD CONSTRAINT "warehouse_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
    ADD CONSTRAINT "warehouse_stock_check" CHECK ("stock" >= 0);

-- The client's duplicate-request key and the Order Request (quantity and
-- destination) are stored on the accepted Order itself; rejected requests are
-- not persisted, so they consume no key. unit_price * quantity is
-- evaluated in unbounded NUMERIC, so the subtotal comparison is exact; a
-- product beyond NUMERIC(12,2) cannot be stored in merchandise_subtotal, so
-- such a row always fails.
ALTER TABLE "customer_order"
    ADD CONSTRAINT "customer_order_order_number_check" CHECK (btrim("order_number") <> ''),
    ADD CONSTRAINT "customer_order_submission_key_check"
        CHECK (btrim("submission_key") <> '' AND char_length("submission_key") <= 255),
    ADD CONSTRAINT "customer_order_quantity_check" CHECK ("quantity" > 0),
    ADD CONSTRAINT "customer_order_destination_latitude_check"
        CHECK ("destination_latitude" BETWEEN -90 AND 90),
    ADD CONSTRAINT "customer_order_destination_longitude_check"
        CHECK ("destination_longitude" BETWEEN -180 AND 180),
    ADD CONSTRAINT "customer_order_unit_price_check" CHECK ("unit_price" >= 0),
    ADD CONSTRAINT "customer_order_merchandise_subtotal_check"
        CHECK ("merchandise_subtotal" >= 0
            AND "merchandise_subtotal" = "unit_price" * "quantity"),
    ADD CONSTRAINT "customer_order_discount_rate_check" CHECK ("discount_rate" BETWEEN 0 AND 1),
    ADD CONSTRAINT "customer_order_discount_amount_check" CHECK ("discount_amount" >= 0),
    ADD CONSTRAINT "customer_order_discounted_merchandise_total_check"
        CHECK ("discounted_merchandise_total" >= 0
            AND "discounted_merchandise_total" = "merchandise_subtotal" - "discount_amount"),
    ADD CONSTRAINT "customer_order_shipping_cost_check" CHECK ("shipping_cost" >= 0),
    ADD CONSTRAINT "customer_order_order_total_check"
        CHECK ("order_total" >= 0
            AND "order_total" = "discounted_merchandise_total" + "shipping_cost");

ALTER TABLE "order_allocation"
    ADD CONSTRAINT "order_allocation_quantity_check" CHECK ("quantity" > 0);

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

DROP TRIGGER IF EXISTS update_warehouse_updated_at ON "warehouse";
CREATE TRIGGER update_warehouse_updated_at
BEFORE UPDATE ON "warehouse"
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS update_customer_order_updated_at ON "customer_order";
CREATE TRIGGER update_customer_order_updated_at
BEFORE UPDATE ON "customer_order"
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS update_order_allocation_updated_at ON "order_allocation";
CREATE TRIGGER update_order_allocation_updated_at
BEFORE UPDATE ON "order_allocation"
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();
