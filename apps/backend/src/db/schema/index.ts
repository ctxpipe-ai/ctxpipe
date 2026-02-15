/**
 * Drizzle schema definitions. Add table definitions here and export them
 * for use in REST routes, MCP tools, and migrations.
 *
 * ID convention: primary keys use TEXT type, format `<prefix>_<base32 encoded uuid>`.
 */
import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core"

export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    zoektRepoId: serial("zoekt_repo_id").notNull().unique(),
    name: text("name").notNull(),
    gitUrl: text("git_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.name, t.orgId),
    unique().on(t.gitUrl, t.orgId),
  ],
)
