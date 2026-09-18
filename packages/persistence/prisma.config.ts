import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env files. Migration and seed commands read
// DATABASE_URL from the environment; `prisma generate` does not need it.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(databaseUrl === undefined || databaseUrl.length === 0
    ? {}
    : { datasource: { url: databaseUrl } }),
});
