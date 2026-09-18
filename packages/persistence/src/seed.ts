export interface WarehouseSeed {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly stock: number;
}

/**
 * The six PRD warehouses. IDs are fixed UUIDv7 values (version 7, RFC 9562
 * variant) so lock ordering and equal-distance tie-breaking stay stable
 * across seed runs and environments. Never change an existing ID.
 */
export const warehouseSeeds: readonly WarehouseSeed[] = Object.freeze([
  {
    id: "01996000-0000-7000-8000-000000000001",
    name: "Los Angeles",
    latitude: 33.9425,
    longitude: -118.408056,
    stock: 355,
  },
  {
    id: "01996000-0000-7000-8000-000000000002",
    name: "New York",
    latitude: 40.639722,
    longitude: -73.778889,
    stock: 578,
  },
  {
    id: "01996000-0000-7000-8000-000000000003",
    name: "São Paulo",
    latitude: -23.435556,
    longitude: -46.473056,
    stock: 265,
  },
  {
    id: "01996000-0000-7000-8000-000000000004",
    name: "Paris",
    latitude: 49.009722,
    longitude: 2.547778,
    stock: 694,
  },
  {
    id: "01996000-0000-7000-8000-000000000005",
    name: "Warsaw",
    latitude: 52.165833,
    longitude: 20.967222,
    stock: 245,
  },
  {
    id: "01996000-0000-7000-8000-000000000006",
    name: "Hong Kong",
    latitude: 22.308889,
    longitude: 113.914444,
    stock: 419,
  },
] satisfies WarehouseSeed[]);

/** Minimal pg query surface, satisfied by pg Pool, PoolClient, and Client. */
export interface SeedQueryable {
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Inserts missing seed warehouses. Existing rows are left untouched, so a
 * rerun never replenishes consumed stock. A conflicting name under a
 * different ID fails loudly instead of being overwritten.
 */
export async function seedWarehouses(
  database: SeedQueryable,
  seeds: readonly WarehouseSeed[] = warehouseSeeds,
): Promise<{ inserted: number; existing: number }> {
  const values: unknown[] = [];
  const rows = seeds.map((seed, index) => {
    const offset = index * 5;
    values.push(seed.id, seed.name, seed.latitude, seed.longitude, seed.stock);
    return `($${offset + 1}::uuid, $${offset + 2}, $${offset + 3}::double precision, $${offset + 4}::double precision, $${offset + 5}::integer)`;
  });
  const result = await database.query(
    `INSERT INTO warehouses (id, name, latitude, longitude, stock)
     VALUES ${rows.join(",\n            ")}
     ON CONFLICT (id) DO NOTHING`,
    values,
  );
  const inserted = result.rowCount ?? 0;
  return { inserted, existing: seeds.length - inserted };
}
