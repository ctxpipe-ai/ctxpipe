/**
 * Read-only mirror of backend repositories table.
 * Migrations and schema changes are done in apps/backend; keep in sync.
 */
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

export const repositories = pgTable("repositories", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  zoektRepoId: serial("zoekt_repo_id").notNull().unique(),
  name: text("name").notNull(),
  gitUrl: text("git_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
