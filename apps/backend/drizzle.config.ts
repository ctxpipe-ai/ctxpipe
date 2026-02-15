import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5433/ctxpipe",
  },
})
